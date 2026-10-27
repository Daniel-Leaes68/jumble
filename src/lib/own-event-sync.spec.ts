import { ApplicationDataKey, ExtendedKind } from '@/constants'
import type { Event, Filter } from 'nostr-tools'
import { kinds } from 'nostr-tools'
import { describe, expect, it, vi } from 'vitest'
import { startOwnEventSync } from './own-event-sync'

const pubkey = 'a'.repeat(64)
const event = (id: string, time: number, kind: number = kinds.Contacts): Event => ({
  id,
  created_at: time,
  kind,
  pubkey,
  tags: [['p', 'b'.repeat(64)]],
  content: '',
  sig: ''
})

function setup() {
  const connections: {
    urls: string[]
    filters: Filter[]
    handlers: { onevent: (event: Event) => void }
    close: ReturnType<typeof vi.fn>
  }[] = []
  const subscribe = vi.fn(
    (urls: string[], filters: Filter[], handlers: { onevent: (event: Event) => void }) => {
      const close = vi.fn()
      connections.push({ urls, filters, handlers, close })
      return { close }
    }
  )
  // Models the shared IndexedDB winner contract, including another tab having
  // written an event before this tab's relay callback receives it.
  const stored = new Map<number, Event>()
  const persist = vi.fn(async (incoming: Event) => {
    const previous = stored.get(incoming.kind)
    if (previous && previous.created_at >= incoming.created_at) return previous
    stored.set(incoming.kind, incoming)
    return incoming
  })
  const apply = vi.fn(async (_event: Event, _isActive: () => boolean) => {})
  const onError = vi.fn()
  const sync = startOwnEventSync({
    pubkey,
    relayUrls: ['wss://relay.example'],
    subscribe,
    persist,
    apply,
    onError
  })
  return { sync, connections, persist, apply, onError, stored }
}

describe('own account event synchronization', () => {
  it('keeps two pages current when one publishes a follow or unfollow', async () => {
    const first = setup()
    const second = setup()
    const pageEvents = [event('follow', 1), { ...event('unfollow', 2), tags: [] }]
    for (const update of pageEvents) {
      first.connections[0].handlers.onevent(update)
      second.connections[0].handlers.onevent(update)
      await Promise.all([first.sync.settled(), second.sync.settled()])
      expect(first.apply).toHaveBeenLastCalledWith(update, expect.any(Function))
      expect(second.apply).toHaveBeenLastCalledWith(update, expect.any(Function))
    }
    expect(second.connections[0].close).not.toHaveBeenCalled()
  })

  it('subscribes to all supported account state and isolates notification application data', () => {
    const { connections } = setup()
    const filters = connections[0].filters
    expect(filters[0].authors).toEqual([pubkey])
    expect(filters[0].kinds).toEqual(
      expect.arrayContaining([
        kinds.Metadata,
        kinds.Contacts,
        kinds.RelayList,
        kinds.Mutelist,
        kinds.BookmarkList,
        kinds.UserEmojiList,
        kinds.Pinlist,
        ExtendedKind.PINNED_USERS,
        ExtendedKind.FAVORITE_RELAYS,
        ExtendedKind.BLOSSOM_SERVER_LIST
      ])
    )
    expect(filters[1]).toEqual({
      authors: [pubkey],
      kinds: [kinds.Application],
      '#d': [ApplicationDataKey.NOTIFICATIONS_SEEN_AT]
    })
    expect(connections[0].handlers).not.toHaveProperty('oneose')
  })

  it('uses the shared stored winner even if the received event is stale', async () => {
    const s = setup()
    const winner = event('new-in-other-tab', 30)
    s.stored.set(kinds.Contacts, winner)
    s.connections[0].handlers.onevent(event('old', 10))
    await s.sync.settled()
    expect(s.apply).toHaveBeenCalledExactlyOnceWith(winner, expect.any(Function))
    s.connections[0].handlers.onevent(event('older', 5))
    s.connections[0].handlers.onevent(winner)
    await s.sync.settled()
    expect(s.apply).toHaveBeenCalledTimes(1)
  })

  it('serializes asynchronous state application without reverting a newer event', async () => {
    const s = setup()
    let release!: () => void
    s.apply.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    s.connections[0].handlers.onevent(event('first', 1))
    await vi.waitFor(() => expect(s.apply).toHaveBeenCalledTimes(1))
    s.connections[0].handlers.onevent(event('second', 2))
    await Promise.resolve()
    expect(s.persist).toHaveBeenCalledTimes(1)
    release()
    await s.sync.settled()
    expect(s.apply.mock.calls.map(([e]) => e.id)).toEqual(['first', 'second'])
  })

  it('ignores other authors, notes and unrelated application data', async () => {
    const s = setup()
    for (const incoming of [
      { ...event('other', 1), pubkey: 'other' },
      event('note', 1, kinds.ShortTextNote),
      { ...event('app', 1, kinds.Application), tags: [['d', 'unrelated']] }
    ])
      s.connections[0].handlers.onevent(incoming)
    await s.sync.settled()
    expect(s.persist).not.toHaveBeenCalled()
  })

  it('applies notification cursors and independent state kinds', async () => {
    const s = setup()
    const updates = [
      event('mute', 2, kinds.Mutelist),
      event('bookmarks', 2, kinds.BookmarkList),
      {
        ...event('seen', 2, kinds.Application),
        tags: [['d', ApplicationDataKey.NOTIFICATIONS_SEEN_AT]]
      }
    ]
    updates.forEach((e) => s.connections[0].handlers.onevent(e))
    await s.sync.settled()
    expect(s.apply.mock.calls.map(([e]) => e.id)).toEqual(['mute', 'bookmarks', 'seen'])
  })

  it('closes and replaces relays once when the user changes their relay list', () => {
    const s = setup()
    s.sync.setRelayUrls(['wss://new.example', 'wss://new.example'])
    expect(s.connections[0].close).toHaveBeenCalledOnce()
    expect(s.connections[1].urls).toEqual(['wss://new.example'])
    s.sync.setRelayUrls(['wss://new.example'])
    expect(s.connections).toHaveLength(2)
    s.sync.close()
    expect(s.connections[1].close).toHaveBeenCalledOnce()
    s.sync.setRelayUrls(['wss://ignored.example'])
    expect(s.connections).toHaveLength(2)
  })

  it('drops in-flight and late updates after account switch or unmount', async () => {
    const s = setup()
    let finish!: (value: Event) => void
    s.persist.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    s.connections[0].handlers.onevent(event('pending', 1))
    await vi.waitFor(() => expect(s.persist).toHaveBeenCalledOnce())
    s.sync.close()
    finish(event('pending', 1))
    s.connections[0].handlers.onevent(event('late', 2))
    await s.sync.settled()
    expect(s.apply).not.toHaveBeenCalled()
    expect(s.persist).toHaveBeenCalledOnce()
  })

  it('recovers after a storage failure without leaving an unhandled rejection', async () => {
    const s = setup()
    s.persist.mockRejectedValueOnce(new Error('temporary storage failure'))
    s.connections[0].handlers.onevent(event('failed', 1))
    s.connections[0].handlers.onevent(event('next', 2))
    await s.sync.settled()
    expect(s.onError).toHaveBeenCalledOnce()
    expect(s.apply).toHaveBeenCalledExactlyOnceWith(event('next', 2), expect.any(Function))
  })
})
