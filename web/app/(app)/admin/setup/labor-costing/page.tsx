import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { requirePermission } from '../../../../../lib/authz'
import { LaborCostingGuide } from './LaborCostingGuide'

export const dynamic = 'force-dynamic'

export default async function LaborCostingPage() {
  const authz = await requirePermission('admin.setup.manage')
  const orgId = authz.user.orgId
  const [org, books, accounts, types, sources] = await Promise.all([
    db.execute(sql`select base_currency, settings from orgs where id = ${orgId}`) as any,
    db.execute(sql`select id, name, currency, is_default from item_rate_books where org_id = ${orgId} and is_active order by is_default desc, name`) as any,
    db.execute(sql`select id, number, name from accounts where org_id = ${orgId} and is_active and not is_summary order by number nulls last, name`) as any,
    db.execute(sql`select id, name, labor_rate_book_id, labor_rate_policy from project_types where org_id = ${orgId} and is_active order by sort_order, name`) as any,
    db.execute(sql`select count(*)::int as count from external_payroll_sources where org_id = ${orgId} and is_active`) as any,
  ])
  const settings = (org.rows[0]?.settings ?? {}) as Record<string, any>
  const control = settings.controlAccounts ?? {}
  return <LaborCostingGuide
    currency={org.rows[0]?.base_currency ?? 'CAD'}
    books={books.rows}
    accounts={accounts.rows}
    projectTypes={types.rows}
    sourceCount={sources.rows[0]?.count ?? 0}
    initial={{ rateBookId: books.rows.find((b: any) => b.is_default)?.id ?? '', policy: settings.laborCosting?.defaultRatePolicy ?? 'work_date', laborWip: control.laborWip ?? '', laborClearing: control.laborClearing ?? '', accountingMode: settings.laborCosting?.externalPayrollMode ?? 'costing_only' }}
  />
}
