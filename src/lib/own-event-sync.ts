import { ApplicationDataKey, ExtendedKind } from '@/constants'
import type { Event, Filter } from 'nostr-tools'
import { kinds } from 'nostr-tools'

const stateKinds = [
  kinds.RelayList,
  kinds.Metadata,
  kinds.Contacts,
  kinds.Mutelist,
  kinds.BookmarkList,
  ExtendedKind.FAVORITE_RELAYS,
  ExtendedKind.BLOSSOM_SERVER_LIST,
  kinds.UserEmojiList,
  kinds.Pinlist,
  ExtendedKind.PINNED_USERS
]

type Subscription = { close: () => void }
type Options = {
  pubkey: string
  relayUrls: string[]
  subscribe: (
    urls: string[],
    filters: Filter[],
    handlers: { onevent: (event: Event) => void }
  ) => Subscription
  persist: (event: Event) => Promise<Event>
  apply: (event: Event, isActive: () => boolean) => Promise<void>
  onError: (error: unknown) => void
}

/** Keep the active account's replaceable state live, including updates from
 * other clients. EOSE must not close this subscription. IndexedDB selects the
 * winning event; another tab may already have stored it before we receive it.
 */
export function startOwnEventSync(options: Options) {
  let active = true
  let subscription: Subscription | undefined
  let relayKey: string | undefined
  let pending = Promise.resolve()
  const applied = new Map<number, string>()
  const isActive = () => active
  const accepts = (event: Event) =>
    event.pubkey === options.pubkey &&
    (stateKinds.includes(event.kind) ||
      (event.kind === kinds.Application &&
        event.tags.find((tag) => tag[0] === 'd')?.[1] === ApplicationDataKey.NOTIFICATIONS_SEEN_AT))

  const onevent = (event: Event) => {
    if (!active || !accepts(event)) return
    // Serialize storage and state changes so asynchronous processing cannot
    // let an older event overwrite a newer one. A failed event doesn't stop sync.
    pending = pending
      .then(async () => {
        if (!active) return
        const stored = await options.persist(event)
        if (!active || !accepts(stored) || stored.kind !== event.kind) return
        if (applied.get(stored.kind) === stored.id) return
        await options.apply(stored, isActive)
        if (active) applied.set(stored.kind, stored.id)
      })
      .catch((error) => {
        if (active) options.onError(error)
      })
  }

  const setRelayUrls = (urls: string[]) => {
    if (!active) return
    const uniqueUrls = [...new Set(urls)].sort()
    const key = JSON.stringify(uniqueUrls)
    if (key === relayKey) return
    relayKey = key
    subscription?.close()
    subscription = options.subscribe(
      uniqueUrls,
      [
        { authors: [options.pubkey], kinds: stateKinds },
        {
          authors: [options.pubkey],
          kinds: [kinds.Application],
          '#d': [ApplicationDataKey.NOTIFICATIONS_SEEN_AT]
        }
      ],
      { onevent }
    )
  }

  setRelayUrls(options.relayUrls)
  return {
    setRelayUrls,
    close: () => {
      active = false
      subscription?.close()
    },
    // Also useful for callers waiting for already-received updates to settle.
    settled: () => pending
  }
}
