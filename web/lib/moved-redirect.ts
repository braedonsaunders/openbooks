/**
 * Alias-redirect destinations with the reason attached (UX-17).
 *
 * Several setup entry points are permanent aliases — /admin/settings,
 * /admin/setup, and the payment-providers gate when Online payments is off.
 * A bare redirect lands the reader somewhere unexpected with no explanation,
 * so every alias forwards through `movedUrl`: the reader's own query params
 * travel along (task context stays shareable) and `?movedFrom=<source>`
 * tells the destination's notice which sentence to show. The destination
 * renders it via the SetupRedirectNotice component in the setup layout.
 */

/** The query param naming the alias a reader arrived through. */
export const MOVED_FROM_PARAM = 'movedFrom'

export type MovedFromSource = 'settings' | 'setup-index' | 'payment-providers'

/**
 * Build an alias-redirect target: the destination plus the reader's own
 * params (so a shared link keeps its context) and the `movedFrom` source
 * (so the destination can say where they landed and why). Any incoming
 * `movedFrom` is replaced, never stacked — chained aliases report the
 * latest hop.
 */
export function movedUrl(
  destination: string,
  source: MovedFromSource,
  searchParams?: Record<string, string | string[] | undefined>,
): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (key === MOVED_FROM_PARAM) continue
    if (Array.isArray(value)) {
      for (const entry of value) params.append(key, entry)
    } else if (value !== undefined) {
      params.append(key, value)
    }
  }
  params.set(MOVED_FROM_PARAM, source)
  const query = params.toString()
  return query ? `${destination}?${query}` : destination
}
