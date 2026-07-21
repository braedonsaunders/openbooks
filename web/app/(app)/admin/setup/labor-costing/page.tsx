import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { laborCostingSettings } from '@openbooks/engine/src/labor-costing.ts'
import { requirePermission } from '../../../../../lib/authz'
import { LaborCostingWorkspace, type RateRow } from './LaborCostingWorkspace'

export const dynamic = 'force-dynamic'

/**
 * Labor Costing — ONE workspace answering "what does an hour of labor cost?".
 * Wage rates (effective-dated, employee > trade > org default), the estimate
 * component calculator (statutory burden %, per-diem — inputs that die when
 * payroll actuals arrive), and the posting switch + control accounts.
 * Overhead is deliberately NOT here — that's the Overhead Model's job.
 */
export default async function LaborCostingSetup() {
  const authz = await requirePermission('admin.setup.manage')
  const orgId = authz.user.orgId
  const t = await getTranslations('admin')

  const [settings, ratesRes, employeesRes, tradesRes, accountsRes, orgRes] = await Promise.all([
    laborCostingSettings(orgId),
    db.execute(sql`
      select r.id, r.employee_party_id, r.trade_id, r.rate, r.basis, r.annual_hours,
             r.effective_from::text as effective_from, r.effective_to::text as effective_to, r.notes,
             p.display_name as employee_name, tr.name as trade_name
        from labor_cost_rates r
        left join parties p on p.id = r.employee_party_id
        left join trades tr on tr.id = r.trade_id
       where r.org_id = ${orgId} and r.is_active
       order by case when r.employee_party_id is not null then 0 when r.trade_id is not null then 1 else 2 end,
                coalesce(p.display_name, tr.name, ''), r.effective_from desc`),
    db.execute(sql`
      select p.id, p.display_name as name from parties p
       where p.org_id = ${orgId} and p.is_active
         and exists (select 1 from employee_roles r where r.party_id = p.id and r.org_id = ${orgId} and r.is_active)
       order by p.display_name`),
    db.execute(sql`select id, name from trades where org_id = ${orgId} and is_active order by name`),
    db.execute(sql`
      select id, number, name from accounts
       where org_id = ${orgId} and is_active order by number nulls last, name`),
    db.execute(sql`select settings->'controlAccounts' as c from orgs where id = ${orgId}`),
  ])

  const control = ((orgRes as unknown as { rows: { c: Record<string, string> | null }[] }).rows[0]?.c ?? {}) as Record<string, string>
  const opt = (r: Record<string, unknown>) => ({ id: String(r.id), name: String(r.name ?? '') })

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">{t('setup.laborCosting.title')}</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('setup.laborCosting.description')}</p>
      </div>
      <LaborCostingWorkspace
        settings={settings}
        rates={(ratesRes as unknown as { rows: RateRow[] }).rows}
        employees={(employeesRes as unknown as { rows: Record<string, unknown>[] }).rows.map(opt)}
        trades={(tradesRes as unknown as { rows: Record<string, unknown>[] }).rows.map(opt)}
        accounts={(accountsRes as unknown as { rows: Record<string, unknown>[] }).rows.map((r) => ({
          id: String(r.id),
          label: r.number ? `${r.number} · ${r.name}` : String(r.name ?? ''),
        }))}
        laborWip={control.laborWip ?? null}
        laborClearing={control.laborClearing ?? null}
        payrollVariance={control.payrollVariance ?? null}
      />
    </div>
  )
}
