import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { BookOpen } from 'lucide-react'
import { cn } from '@openbooks/ui'
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
const VIEWS = ['rates', 'components', 'posting', 'reconciliation'] as const
export type LaborCostingView = (typeof VIEWS)[number]

export default async function LaborCostingSetup({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('admin.setup.manage')
  const orgId = authz.user.orgId
  const t = await getTranslations('admin')
  const sp = await searchParams
  const rawView = typeof sp.view === 'string' ? sp.view : ''
  const view: LaborCostingView = (VIEWS as readonly string[]).includes(rawView) ? (rawView as LaborCostingView) : 'rates'

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

  // Coverage: how many active employees resolve to SOME current wage rate
  // (their own, their trade's, or the org default) — the number the checklist
  // and the wizard lead with.
  const coverageRes = (await db.execute(sql`
    with active_emp as (
      select p.id, er.trade_id from parties p
      join employee_roles er on er.party_id = p.id and er.org_id = ${orgId} and er.is_active
     where p.org_id = ${orgId} and p.is_active
    ),
    current_rates as (
      select employee_party_id, trade_id from labor_cost_rates
       where org_id = ${orgId} and is_active and effective_from <= current_date
         and (effective_to is null or effective_to >= current_date)
    )
    select
      (select count(*) from active_emp) as employees,
      (select count(*) from active_emp e where
         exists (select 1 from current_rates r where r.employee_party_id = e.id)
         or exists (select 1 from current_rates r where r.employee_party_id is null and r.trade_id = e.trade_id and r.trade_id is not null)
         or exists (select 1 from current_rates r where r.employee_party_id is null and r.trade_id is null)
      ) as covered,
      exists (select 1 from current_rates where employee_party_id is null and trade_id is null) as has_org_default`)) as unknown as {
    rows: { employees: number; covered: number; has_org_default: boolean }[]
  }
  const coverage = coverageRes.rows[0] ?? { employees: 0, covered: 0, has_org_default: false }
  const opt = (r: Record<string, unknown>) => ({ id: String(r.id), name: String(r.name ?? '') })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">{t('setup.laborCosting.title')}</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('setup.laborCosting.description')}</p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/docs/labor-costing"
            className="flex items-center gap-1 text-xs font-medium text-teal-700 hover:underline dark:text-teal-300"
          >
            <BookOpen size={13} aria-hidden /> {t('setup.laborCosting.docs')}
          </Link>
          <Link
            href="/admin/setup/overhead"
            className="text-xs font-medium text-teal-700 hover:underline dark:text-teal-300"
          >
            {t('setup.entities.overhead-model.title')} →
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800">
        {VIEWS.map((item) => (
          <Link
            key={item}
            href={`/admin/setup/labor-costing?view=${item}`}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium',
              view === item
                ? 'border-teal-600 text-teal-700 dark:text-teal-300'
                : 'border-transparent text-slate-500 hover:text-slate-900 dark:hover:text-slate-100',
            )}
          >
            {t(`setup.laborCosting.tabs.${item}`)}
          </Link>
        ))}
      </div>
      <LaborCostingWorkspace
        view={view}
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
        coverage={{ employees: Number(coverage.employees), covered: Number(coverage.covered), hasOrgDefault: coverage.has_org_default === true }}
      />
    </div>
  )
}
