/**
 * URL-drawer close/reopen rules. These are load-bearing: a stale afterExit
 * navigation is how a second drill dies, and an open-flag that stays true
 * while `show` is false is how the first close permanently hides the panel.
 */

export function normalizePathQuery(href: string): string {
  const url = href.startsWith('http://') || href.startsWith('https://')
    ? new URL(href)
    : new URL(href, 'https://overlay.local')
  const query = url.searchParams.toString()
  return query ? `${url.pathname}?${query}` : url.pathname
}

/**
 * Close navigation is deferred until the exit animation finishes.
 * A newer overlay (another drill, an already-stripped URL) must win.
 */
export function shouldCommitDrawerCloseNavigation(args: {
  urlWhenClosed: string
  urlNow: string
  closeHref: string
}): boolean {
  const now = normalizePathQuery(args.urlNow)
  if (now === normalizePathQuery(args.closeHref)) return false
  if (now !== normalizePathQuery(args.urlWhenClosed)) return false
  return true
}

/**
 * Mirror `open` into local `show`, and remount when the open target identity
 * changes even if `open` stayed true (second drill while the first is still
 * flagged open in the URL).
 */
export function nextDrawerShow(state: {
  open: boolean
  show: boolean
  prevOpen: boolean
  openKey?: string
  prevOpenKey?: string
}): { show: boolean; prevOpen: boolean; prevOpenKey?: string } {
  let { show, prevOpen, prevOpenKey } = state
  if (prevOpen !== state.open) {
    prevOpen = state.open
    show = state.open
  }
  if (state.open && state.openKey !== undefined && state.openKey !== prevOpenKey) {
    prevOpenKey = state.openKey
    show = true
  } else if (state.openKey !== undefined) {
    prevOpenKey = state.openKey
  }
  return { show, prevOpen, prevOpenKey }
}
