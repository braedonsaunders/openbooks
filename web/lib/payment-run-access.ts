import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import type { Authz } from './authz'
import { subsidiaryVisibleFilter } from './subsidiaries'

/** A run exposes its header and all retained source evidence, including
 * excluded items. Lists, counts, drawers and API verbs share this boundary. */
export function paymentRunScopeSql(authz: Authz, alias = 'r'): SQL {
  const col = (name: string) =>
    sql`${sql.identifier(alias)}.${sql.identifier(name)}`
  const org = sql`${col('org_id')} = ${authz.user.orgId}`
  const allowed = authz.allowedSubsidiaryIds
  if (allowed === null) return org
  if (allowed.size === 0) return sql`false`
  const ids = `{${[...allowed].join(',')}}`
  return sql`(${org}
    and (${col('subsidiary_id')} is null or ${col('subsidiary_id')} = any(${ids}::uuid[]))
    and (${col('subsidiary_id')} is not null or exists (
      select 1 from payment_run_items scope_item
       where scope_item.payment_run_id = ${col('id')} and scope_item.org_id = ${col('org_id')}
    ))
    and not exists (
      select 1 from payment_run_items scope_item
      left join documents scope_doc on scope_doc.id = scope_item.source_document_id and scope_doc.org_id = scope_item.org_id
      where scope_item.payment_run_id = ${col('id')} and scope_item.org_id = ${col('org_id')}
        and (scope_doc.subsidiary_id is null or not (scope_doc.subsidiary_id = any(${ids}::uuid[])))
    ))`
}

/** Bank profiles and party identities can be shared; transactions cannot. */
export function paymentSharedSubsidiaryFilter(column: SQL, authz: Authz): SQL {
  const allowed = authz.allowedSubsidiaryIds
  if (allowed === null) return sql``
  if (allowed.size === 0) return sql` and false`
  return sql` and (${column} is null or (true ${subsidiaryVisibleFilter(column, allowed)}))`
}
