/** Router feedback observes navigation; it never owns routing or admission. */
type PendingNavigation = { sequence: number; href: string }
type Snapshot = { navigation: PendingNavigation | null; fallbacks: number }

let sequence = 0
let committedHref: string | null = null
let snapshot: Snapshot = { navigation: null, fallbacks: 0 }
const listeners = new Set<() => void>()
const publish = (next: Snapshot) => {
  snapshot = next
  for (const listener of listeners) listener()
}

export const navigationPendingSnapshot = () => snapshot
export const navigationPendingServerSnapshot = (): Snapshot => SERVER_SNAPSHOT
const SERVER_SNAPSHOT: Snapshot = { navigation: null, fallbacks: 0 }
export function subscribeNavigationPending(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Called by Next's instrumentation hook, after a navigation is admitted. */
export function beginNavigationPending(href: string) {
  const url = new URL(href, window.location.href)
  if (url.origin !== window.location.origin) return
  const current = new URL(committedHref ?? window.location.href, window.location.origin)
  // Anchor-only moves and native history presentation changes need no server.
  if (url.pathname === current.pathname && url.search === current.search) {
    finishNavigationPending()
    return
  }
  publish({ ...snapshot, navigation: { sequence: ++sequence, href: `${url.pathname}${url.search}` } })
}

/** Content, including an error/refusal, has committed through the route pane. */
export function finishNavigationPending() {
  if (snapshot.navigation) publish({ ...snapshot, navigation: null })
}

export function commitNavigationHref(href: string) {
  committedHref = href
}

export function holdPagePending() {
  publish({ ...snapshot, fallbacks: snapshot.fallbacks + 1 })
  let released = false
  return () => {
    if (released) return
    released = true
    publish({ ...snapshot, fallbacks: snapshot.fallbacks - 1 })
  }
}
