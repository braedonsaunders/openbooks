import 'server-only'
import type { Authz } from './authz'
import { globalSearch, resolveRecentCoreRecords } from './search'
import { resolveRecentOperationalRecords, searchOperationalRecords } from './search-records'
import { resolveRecentCatalog, searchCatalog } from './search-catalog'
import type { RecentRef, SearchHit, SearchResponse } from './search-types'

/**
 * The header search: core ledger records (contacts, transactions, accounts,
 * items, projects), then reports and settings, then operational records,
 * then help. Every source applies its own permission, Features and
 * subsidiary rules; this module only orders their groups.
 */
export async function searchEverything(authz: Authz, rawQ: string): Promise<SearchResponse> {
  const [core, records, catalog] = await Promise.all([
    globalSearch(authz, rawQ),
    searchOperationalRecords(authz, rawQ),
    searchCatalog(authz, rawQ),
  ])
  const groups = [
    ...core.groups,
    ...catalog.filter((group) => group.type !== 'help'),
    ...records,
    ...catalog.filter((group) => group.type === 'help'),
  ]
  return { q: core.q, groups, total: groups.reduce((n, group) => n + group.hits.length, 0) }
}

/**
 * Resolve the reader's recently opened results, most recent first. Each
 * reference re-resolves through the source that produced it, so what comes
 * back is exactly what the reader may open now.
 */
export async function resolveRecent(authz: Authz, refs: readonly RecentRef[]): Promise<SearchHit[]> {
  const [core, records, catalog] = await Promise.all([
    resolveRecentCoreRecords(authz, refs),
    resolveRecentOperationalRecords(authz, refs),
    resolveRecentCatalog(authz, refs),
  ])
  const byRef = new Map([...core, ...records, ...catalog].map((hit) => [`${hit.type}:${hit.id}`, hit]))
  return refs.flatMap((ref) => {
    const hit = byRef.get(`${ref.type}:${ref.id}`)
    return hit ? [hit] : []
  })
}
