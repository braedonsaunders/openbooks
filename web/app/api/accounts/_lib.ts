import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'

export interface AccountPayload {
  account: Record<string, unknown>
  parentName: string | null
  subsidiaryName: string | null
  hasTransactions: boolean
  childCount: number
  activeChildCount: number
}

/** Tenant-scoped account payload used by both the list flyout and API. */
export async function loadAccount(id: string, orgId: string): Promise<AccountPayload | null> {
  const result = (await db.execute(sql`
    select a.*,
           case when parent.id is null then null else concat_ws(' ', parent.number, parent.name) end as parent_name,
           s.name as subsidiary_name,
           exists(select 1 from journal_lines l where l.org_id = a.org_id and l.account_id = a.id) as has_transactions,
           (select count(*)::int from accounts child
             where child.org_id = a.org_id and child.parent_id = a.id) as child_count,
           (select count(*)::int from accounts child
             where child.org_id = a.org_id and child.parent_id = a.id and child.is_active) as active_child_count
      from accounts a
      left join accounts parent on parent.id = a.parent_id and parent.org_id = a.org_id
      left join subsidiaries s on s.id = a.subsidiary_id and s.org_id = a.org_id
     where a.id = ${id} and a.org_id = ${orgId}
  `)) as unknown as { rows: Array<Record<string, unknown>> }
  const row = result.rows[0]
  if (!row) return null
  const { parent_name, subsidiary_name, has_transactions, child_count, active_child_count, ...account } = row
  return {
    account,
    parentName: (parent_name as string | null) ?? null,
    subsidiaryName: (subsidiary_name as string | null) ?? null,
    hasTransactions: has_transactions === true,
    childCount: Number(child_count ?? 0),
    activeChildCount: Number(active_child_count ?? 0),
  }
}
