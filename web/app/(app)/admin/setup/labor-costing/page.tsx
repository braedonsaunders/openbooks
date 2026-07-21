import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { BookOpen, Sparkles } from 'lucide-react'
import { Button, cn } from '@openbooks/ui'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { laborCostingSettings } from '@openbooks/engine/src/labor-costing.ts'
import { requirePermission } from '../../../../../lib/authz'
import { isUuid, mergeHref, parseListParams, pickString } from '../../../../../lib/list-params'
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

const RATE_STATUSES = ['all', 'active', 'current', 'scheduled', 'ended'] as const
type RateStatus = (typeof RATE_STATUSES)[number]
const RATE_SCOPES = ['all', 'trade', 'org'] as const
type RateScope = (typeof RATE_SCOPES)[number]

export default async function LaborCostingSetup({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const authz = await requirePermission('admin.setup.manage')
  const orgId = authz.user.orgId
  const t = await getTranslations('admin')
  const sp = await searchParams
  const rawView = pickString(sp.view) ?? ''
  const view: LaborCostingView = (VIEWS as readonly string[]).includes(rawView) ? (rawView as LaborCostingView) : 'rates'
  const list = parseListParams(sp, {
    sort: 'scope',
    allowedSorts: ['scope'] as const,
    dir: 'asc',
    perPage: 25,
  })
  const rawStatus = pickString(sp.rateStatus) ?? 'active'
  const rateStatus: RateStatus = (RATE_STATUSES as readonly string[]).includes(rawStatus) ? (rawStatus as RateStatus) : 'active'
  const rawScope = pickString(sp.rateScope) ?? 'all'
  const rateScope: RateScope = (RATE_SCOPES as readonly string[]).includes(rawScope) ? (rawScope as RateScope) : 'all'
  const rateParam = pickString(sp.rate)
  const creatingRate = rateParam === 'new'

  const statusFilter =
    rateStatus === 'current'
      ? sql`and r.effective_from <= current_date and (r.effective_to is null or r.effective_to >= current_date)`
      : rateStatus === 'scheduled'
        ? sql`and r.effective_from > current_date and (r.effective_to is null or r.effective_to >= r.effective_from)`
        : rateStatus === 'ended'
          ? sql`and r.effective_to < current_date`
          : rateStatus === 'active'
            ? sql`and (r.effective_to is null or r.effective_to >= current_date)`
            : sql``
  const scopeFilter = rateScope === 'trade' ? sql`and r.trade_id is not null` : rateScope === 'org' ? sql`and r.trade_id is null` : sql``
  const searchFilter = list.q ? sql`and (coalesce(tr.name, '') ilike ${`%${list.q}%`} or cast(r.rate as text) ilike ${`%${list.q}%`} or coalesce(r.notes, '') ilike ${`%${list.q}%`})` : sql``
  const rateFilter = sql`
    where r.org_id = ${orgId} and r.is_active and r.employee_party_id is null
      ${statusFilter} ${scopeFilter} ${searchFilter}`
  const rateSelect = sql`
    select r.id, r.employee_party_id, r.trade_id, r.rate, r.basis, r.annual_hours,
           r.effective_from::text as effective_from, r.effective_to::text as effective_to, r.notes,
           null::text as employee_name, tr.name as trade_name
      from labor_cost_rates r
      left join trades tr on tr.id = r.trade_id`

  const [settings, ratesRes, rateCountRes, selectedRateRes, tradesRes, accountsRes, orgRes, coverageRes] = await Promise.all([
    laborCostingSettings(orgId),
    db.execute(sql`${rateSelect} ${rateFilter}
      order by case when r.trade_id is not null then 0 else 1 end,
               coalesce(tr.name, ''), r.effective_from desc
      limit ${list.perPage} offset ${(list.page - 1) * list.perPage}`),
    db.execute(sql`select count(*)::int as n from labor_cost_rates r left join trades tr on tr.id = r.trade_id ${rateFilter}`),
    rateParam && rateParam !== 'new' && isUuid(rateParam)
      ? db.execute(sql`${rateSelect}
          where r.org_id = ${orgId} and r.id = ${rateParam} and r.is_active and r.employee_party_id is null
          limit 1`)
      : Promise.resolve({ rows: [] }),
    db.execute(sql`select id, name from trades where org_id = ${orgId} and is_active order by name`),
    db.execute(sql`
      select id, number, name from accounts
       where org_id = ${orgId} and is_active and not is_summary order by number nulls last, name`),
    db.execute(sql`select settings->'controlAccounts' as c, base_currency from orgs where id = ${orgId}`),
    db.execute(sql`
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
        exists (select 1 from current_rates where employee_party_id is null and trade_id is null) as has_org_default`),
  ])

  const org = (
    orgRes as unknown as {
      rows: { c: Record<string, string> | null; base_currency: string }[]
    }
  ).rows[0] ?? {
    c: null,
    base_currency: 'CAD',
  }
  const control = (org.c ?? {}) as Record<string, string>
  const coverageRow = (
    coverageRes as unknown as {
      rows: { employees: number; covered: number; has_org_default: boolean }[]
    }
  ).rows[0] ?? { employees: 0, covered: 0, has_org_default: false }
  const opt = (r: Record<string, unknown>) => ({
    id: String(r.id),
    name: String(r.name ?? ''),
  })
  const basePath = '/admin/setup/labor-costing'
  const guideHref = mergeHref(basePath, sp, {
    guide: 'setup',
    rate: undefined,
  })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">{t('setup.laborCosting.title')}</h2>
          <p className="max-w-4xl text-sm text-slate-500 dark:text-slate-400">{t('setup.laborCosting.description')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={guideHref as never}>
              <Sparkles size={14} aria-hidden /> {t('setup.laborCosting.checklist.launchWizard')}
            </Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href="/docs/labor-costing">
              <BookOpen size={14} aria-hidden /> {t('setup.laborCosting.docs')}
            </Link>
          </Button>
          <Link href="/admin/setup/overhead" className="px-1 text-xs font-medium text-teal-700 hover:underline dark:text-teal-300">
            {t('setup.entities.overhead-model.title')} →
          </Link>
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800">
        {VIEWS.map((item) => (
          <Link
            key={item}
            href={`${basePath}?view=${item}`}
            className={cn(
              '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium',
              view === item ? 'border-teal-600 text-teal-700 dark:text-teal-300' : 'border-transparent text-slate-500 hover:text-slate-900 dark:hover:text-slate-100',
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
        selectedRate={(selectedRateRes as unknown as { rows: RateRow[] }).rows[0] ?? null}
        creatingRate={creatingRate}
        guideOpen={pickString(sp.guide) === 'setup'}
        currentParams={sp}
        totalRates={Number((rateCountRes as unknown as { rows: { n: number }[] }).rows[0]?.n ?? 0)}
        ratePage={list.page}
        ratePerPage={list.perPage}
        trades={(tradesRes as unknown as { rows: Record<string, unknown>[] }).rows.map(opt)}
        accounts={(accountsRes as unknown as { rows: Record<string, unknown>[] }).rows.map((r) => ({
          id: String(r.id),
          label: r.number ? `${r.number} · ${r.name}` : String(r.name ?? ''),
        }))}
        currency={org.base_currency}
        laborWip={control.laborWip ?? null}
        laborClearing={control.laborClearing ?? null}
        payrollVariance={control.payrollVariance ?? null}
        coverage={{
          employees: Number(coverageRow.employees),
          covered: Number(coverageRow.covered),
          hasOrgDefault: coverageRow.has_org_default === true,
        }}
      />
    </div>
  )
}
