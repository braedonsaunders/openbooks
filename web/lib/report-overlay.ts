import {
  REPORT_DRILL_FROM_PARAM,
  REPORT_DRILL_PERIOD_PARAM,
  REPORT_DRILL_TO_PARAM,
} from './report-drill'

/**
 * Search-param chrome that sits ON TOP of a report (or any page that hosts
 * the shared report drawer stack). These keys are not report inputs: changing
 * them must not re-run a force-dynamic report loader. The paper already
 * resolved; the drawer is a client overlay over that paper.
 *
 * Account-register keys live here too: the register is the same stack (a
 * UrlDrawer over the current page) and its API already loads its own rows.
 */
export const REPORT_OVERLAY_PARAMS = [
  'reportDrill',
  'reportDrillPage',
  REPORT_DRILL_PERIOD_PARAM,
  REPORT_DRILL_FROM_PARAM,
  REPORT_DRILL_TO_PARAM,
  'reportRecord',
  'reportRecordKind',
  'txn',
  'drawerReturn',
  'form',
  'transactionTab',
  'accountRegister',
  'accountRegisterPage',
  'accountRegisterFrom',
  'accountRegisterTo',
  'accountRegisterQ',
] as const

const OVERLAY_KEYS = new Set<string>(REPORT_OVERLAY_PARAMS)

export function isReportOverlayParam(key: string): boolean {
  return OVERLAY_KEYS.has(key)
}

export function stripReportOverlay(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params)
  for (const key of OVERLAY_KEYS) next.delete(key)
  return next
}

/** Canonical report-input query (overlay chrome removed, keys stable). */
export function reportFilterQuery(params: URLSearchParams): string {
  const stripped = stripReportOverlay(params)
  stripped.sort()
  return stripped.toString()
}

function parsePathQuery(href: string): { pathname: string; params: URLSearchParams } {
  const url = href.startsWith('http://') || href.startsWith('https://')
    ? new URL(href)
    : new URL(href, 'https://overlay.local')
  return { pathname: url.pathname, params: url.searchParams }
}

/**
 * True when two hrefs name the same page and the same report filters — only
 * overlay chrome differs (including opening or closing a drawer).
 */
export function isOverlayOnlyHrefChange(currentPathAndQuery: string, nextHref: string): boolean {
  const current = parsePathQuery(currentPathAndQuery)
  const next = parsePathQuery(nextHref)
  if (current.pathname !== next.pathname) return false
  return reportFilterQuery(current.params) === reportFilterQuery(next.params)
}

export function hrefFromParts(pathname: string, params: URLSearchParams): string {
  const query = params.toString()
  return query ? `${pathname}?${query}` : pathname
}

export function hrefWithOverlay(
  pathname: string,
  currentSearch: string,
  overlayUpdates: Record<string, string | null | undefined>,
): string {
  const params = new URLSearchParams(currentSearch)
  for (const [key, value] of Object.entries(overlayUpdates)) {
    if (value == null || value === '') params.delete(key)
    else params.set(key, value)
  }
  return hrefFromParts(pathname, params)
}

export function hrefWithoutKeys(
  pathname: string,
  currentSearch: string,
  keys: readonly string[],
): string {
  const params = new URLSearchParams(currentSearch)
  for (const key of keys) params.delete(key)
  return hrefFromParts(pathname, params)
}

export function hrefWithoutOverlay(
  pathname: string,
  currentSearch: string,
  extraKeys: readonly string[] = [],
): string {
  return hrefWithoutKeys(pathname, currentSearch, [...OVERLAY_KEYS, ...extraKeys])
}

