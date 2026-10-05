import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { paymentRunVisibleSql } from '@openbooks/engine/payments/run-scope'
import type { Authz } from './authz'
import { subsidiaryVisibleFilter } from './subsidiaries'

/** A run's record boundary for the caller: lists, counts, drawers, API verbs
 * and the run's Flows approval subject share the engine's one definition. */
export function paymentRunScopeSql(authz: Authz, alias = 'r'): SQL {
  return paymentRunVisibleSql(authz.user.orgId, authz.allowedSubsidiaryIds, alias)
}

/** Bank profiles and party identities can be shared; transactions cannot. */
export function paymentSharedSubsidiaryFilter(column: SQL, authz: Authz): SQL {
  const allowed = authz.allowedSubsidiaryIds
  if (allowed === null) return sql``
  if (allowed.size === 0) return sql` and false`
  return sql` and (${column} is null or (true ${subsidiaryVisibleFilter(column, allowed)}))`
}
