import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { requirePermission } from '../../../../../lib/authz'
import { ProjectTypesWorkspace, type ProjectTypeRow } from './ProjectTypesWorkspace'

export const dynamic = 'force-dynamic'

export default async function ProjectTypesSetup() {
  const authz = await requirePermission('admin.setup.manage')
  const orgId = authz.user.orgId

  const [typesRes, dimsRes, acctRes, rateBooksRes] = await Promise.all([
    db.execute(sql`
      select id, key, name, description, is_built_in as "isBuiltIn", is_active as "isActive",
             sort_order as "sortOrder", billing_method as "billingMethod",
             labor_rate_book_id as "laborRateBookId", labor_rate_policy as "laborRatePolicy",
             financial_profile as "financialProfile", invoicing_profile as "invoicingProfile",
             backup_profile as "backupProfile"
        from project_types where org_id = ${orgId} order by sort_order, name`),
    db.execute(sql`select distinct dimension from account_groups where org_id = ${orgId} order by dimension`),
    db.execute(sql`
      select id, number, name from accounts
       where org_id = ${orgId} and is_active and coalesce(is_summary,false) = false
         and type in ('income','income_other') order by number limit 500`),
    db.execute(sql`
      select id, name from item_rate_books where org_id = ${orgId} and is_active order by name`),
  ])

  return (
    <ProjectTypesWorkspace
      types={(typesRes as unknown as { rows: ProjectTypeRow[] }).rows}
      dimensions={(dimsRes as unknown as { rows: { dimension: string }[] }).rows.map((r) => r.dimension)}
      incomeAccounts={(acctRes as unknown as { rows: { id: string; number: string; name: string }[] }).rows}
      rateBooks={(rateBooksRes as unknown as { rows: { id: string; name: string }[] }).rows}
    />
  )
}
