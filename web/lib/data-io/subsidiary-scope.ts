import { sql, type SQL } from 'drizzle-orm'

/**
 * SQL predicate shared by resource adapters whose source table carries a
 * subsidiary_id. IDs are resolved from the authorization layer, not request
 * input; an empty allow-list still fails closed rather than becoming an
 * unscoped query.
 */
export function subsidiaryReadFilter(
  column: SQL,
  allowed: ReadonlySet<string> | null | undefined,
): SQL {
  if (allowed === null || allowed === undefined) return sql``
  const ids = [...allowed]
  if (ids.length === 0) return sql` and false`
  return sql` and ${column} = any(${`{${ids.join(',')}}`}::uuid[])`
}

/**
 * Master-data variant of subsidiaryReadFilter for registries whose rows may
 * carry no subsidiary stamp (the org-wide chart, unassigned parties).
 * Unstamped rows stay visible to scoped readers — the policy the old
 * label-based post-filter applied — but membership is decided by the ROW's
 * own subsidiary_id, never by a display label another subsidiary can reuse.
 * Filtering by label let two codeless parties named 'Acme' in different
 * legal entities leak each other's full rows into a scoped export.
 *
 * Dependency-light on purpose (drizzle tag only): the unit-test doubles
 * for resource-core re-export this module's real implementation, so it must
 * not pull in db, authz, or any other mockable surface.
 */
export function subsidiaryReadFilterWithUnassigned(
  column: SQL,
  allowed: ReadonlySet<string> | null | undefined,
): SQL {
  if (allowed === null || allowed === undefined) return sql``
  const ids = [...allowed]
  if (ids.length === 0) return sql` and false`
  return sql` and (${column} is null or ${column} = any(${`{${ids.join(',')}}`}::uuid[]))`
}
