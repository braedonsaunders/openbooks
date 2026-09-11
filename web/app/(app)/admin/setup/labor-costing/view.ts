import 'server-only'

import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { db } from '@openbooks/engine/src/db.ts'
import { laborCostingSettings, type LaborCostingSettings } from '@openbooks/engine/src/labor-costing.ts'
import { requirePermission } from '../../../../../lib/authz'
import { isUuid, mergeHref, parseListParams, pickString } from '../../../../../lib/list-params'
import { subsidiaryFeatureEnabled } from '../../../../../lib/features'
import { requireProjectsFeature } from '../../../../../lib/projects-gate'
import { grid, heading, page, ref, textBlock, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import type { RateRow } from './LaborCostingWorkspace'

/**
 * Labor Costing setup — ONE workspace answering "what does an hour of labor
 * cost?". Split into a loader and a spec.
 *
 * The page is two static authored regions (an h2 header with three action
 * buttons, and a four-tab underline strip) plus the `LaborCostingWorkspace`
 * client island: wage rates (effective-dated scopes), the estimate
 * component calculator, the posting switch and the reconciliation loader
 * all own `useState` (settings draft, rec range/result, rate drawer), so
 * the workspace arrives whole through one widget — decomposing its
 * filterable rate grid into a spec repeat would render the unfiltered set
 * and strand the search input from what it filters (the /reports lesson).
 * There is exactly one LaborCostingWorkspace; nothing is copied.
 *
 * The header action cluster and the tab strip stay spec-placed, but
 * through NEW widgets, not the existing ones — diffed and found
 * different: `link-button` renders a bare `<Link>` child with no space
 * after its one 14px map icon and no `size="sm"`, while this header needs
 * `<Sparkles size={14} />` + space and `<BookOpen size={14} />` + space
 * inside `size="sm"` outline/ghost buttons plus a teal text link with a
 * literal `→`; `module-home-tabs` is a pill strip, while these tabs are
 * underline links. One component behind one registry entry in both cases.
 *
 * Loader work copied verbatim from page.tsx: the setup.manage gate, the
 * projects feature gate, the subsidiary probe, the view/status/scope
 * whitelists, the rate filters (status/scope/search/subsidiary), the
 * eleven-way fetch, and the currency/subsidiary/guide derivations. The
 * `?view=` tab choice and the `?rate=`/`?guide=` drawer flags are
 * loader-resolved presence strings — the spec never branches.
 */

const BASE = '/admin/setup/labor-costing'
const VIEWS = ['rates', 'components', 'posting', 'reconciliation'] as const
export type LaborCostingView = (typeof VIEWS)[number]

export interface LaborCostingData {
  title: string
  description: string
  guideHref: string
  guideLabel: string
  docsLabel: string
  overheadLabel: string
  tabs: { href: string; label: string; active: boolean }[]
  currentParams: Record<string, string | string[] | undefined>
  view: LaborCostingView
  settings: LaborCostingSettings
  rates: RateRow[]
  selectedRate: RateRow | null
  creatingRate: boolean
  guideOpen: boolean
  totalRates: number
  ratePage: number
  ratePerPage: number
  trades: { id: string; name: string }[]
  departments: { id: string; name: string }[]
  subsidiaries: { id: string; name: string; currency: string }[]
  defaultSubsidiary: { id: string; name: string; currency: string } | null
  jobTitles: string[]
  accounts: { id: string; label: string }[]
  currencies: string[]
  orgCurrency: string
  laborWip: string | null
  laborClearing: string | null
  payrollVariance: string | null
  coverage: { employees: number; covered: number; hasOrgDefault: boolean }
}

export async function loadLaborCosting(
  sp: Record<string, string | string[] | undefined>,
): Promise<LaborCostingData> {
  const authz = await requirePermission('admin.setup.manage')
  const orgId = authz.user.orgId
  const today = await businessToday(orgId)
  await requireProjectsFeature(orgId)
  const subsidiaryUiEnabled = await subsidiaryFeatureEnabled(orgId)
  const t = await getTranslations('admin')
  const rawView = pickString(sp.view) ?? ''
  const view: LaborCostingView = (VIEWS as readonly string[]).includes(rawView) ? (rawView as LaborCostingView) : 'rates'
  const list = parseListParams(sp, {
    sort: 'scope',
    allowedSorts: ['scope'] as const,
    dir: 'asc',
    perPage: 25,
  })
  const RATE_STATUSES = ['all', 'active', 'current', 'scheduled', 'ended'] as const
  type RateStatus = (typeof RATE_STATUSES)[number]
  const RATE_SCOPES = ['all', 'job_title', 'trade', 'department', 'subsidiary', 'org'] as const
  type RateScope = (typeof RATE_SCOPES)[number]
  const rawStatus = pickString(sp.rateStatus) ?? 'active'
  const rateStatus: RateStatus = (RATE_STATUSES as readonly string[]).includes(rawStatus) ? (rawStatus as RateStatus) : 'active'
  const rawScope = pickString(sp.rateScope) ?? 'all'
  const rateScope: RateScope = (RATE_SCOPES as readonly string[]).includes(rawScope) ? (rawScope as RateScope) : 'all'
  const rateParam = pickString(sp.rate)
  const creatingRate = rateParam === 'new'

  const statusFilter =
    rateStatus === 'current'
      ? sql`and r.effective_from <= ${today} and (r.effective_to is null or r.effective_to >= ${today})`
      : rateStatus === 'scheduled'
        ? sql`and r.effective_from > ${today} and (r.effective_to is null or r.effective_to >= r.effective_from)`
        : rateStatus === 'ended'
          ? sql`and r.effective_to < ${today}`
          : rateStatus === 'active'
            ? sql`and (r.effective_to is null or r.effective_to >= ${today})`
            : sql``
  const scopeFilter = rateScope === 'job_title' ? sql`and r.job_title is not null`
    : rateScope === 'trade' ? sql`and r.trade_id is not null`
      : rateScope === 'department' ? sql`and r.department_id is not null`
        : rateScope === 'subsidiary' ? sql`and r.subsidiary_id is not null`
          : rateScope === 'org' ? sql`and num_nonnulls(r.job_title, r.trade_id, r.department_id, r.subsidiary_id) = 0`
            : sql``
  const searchFilter = list.q ? sql`and (coalesce(r.job_title, '') ilike ${`%${list.q}%`} or coalesce(tr.name, '') ilike ${`%${list.q}%`} or coalesce(dep.name, '') ilike ${`%${list.q}%`} or coalesce(sub.name, '') ilike ${`%${list.q}%`} or cast(r.rate as text) ilike ${`%${list.q}%`} or r.currency ilike ${`%${list.q}%`} or coalesce(r.notes, '') ilike ${`%${list.q}%`})` : sql``
  const rateFilter = sql`
    where r.org_id = ${orgId} and r.is_active and r.employee_party_id is null
      ${subsidiaryUiEnabled ? sql`` : sql`and r.subsidiary_id is null`}
      ${statusFilter} ${scopeFilter} ${searchFilter}`
  const rateSelect = sql`
    select r.id, r.employee_party_id, r.job_title, r.trade_id, r.department_id, r.subsidiary_id,
           r.currency, r.rate, r.basis, r.annual_hours,
           r.effective_from::text as effective_from, r.effective_to::text as effective_to, r.notes,
           null::text as employee_name, tr.name as trade_name, dep.name as department_name, sub.name as subsidiary_name
      from labor_cost_rates r
      left join trades tr on tr.id = r.trade_id and tr.org_id = r.org_id
      left join departments dep on dep.id = r.department_id and dep.org_id = r.org_id
      left join subsidiaries sub on sub.id = r.subsidiary_id and sub.org_id = r.org_id`

  const [settings, ratesRes, rateCountRes, selectedRateRes, tradesRes, departmentsRes, subsidiariesRes, jobTitlesRes, accountsRes, orgRes, coverageRes] = await Promise.all([
    laborCostingSettings(orgId),
    db.execute(sql`${rateSelect} ${rateFilter}
      order by case when r.job_title is not null then 0 when r.trade_id is not null then 1
                    when r.department_id is not null then 2 when r.subsidiary_id is not null then 3 else 4 end,
               coalesce(r.job_title, tr.name, dep.name, sub.name, ''), r.effective_from desc
      limit ${list.perPage} offset ${(list.page - 1) * list.perPage}`),
    db.execute(sql`select count(*)::int as n from labor_cost_rates r left join trades tr on tr.id = r.trade_id and tr.org_id = r.org_id left join departments dep on dep.id = r.department_id and dep.org_id = r.org_id left join subsidiaries sub on sub.id = r.subsidiary_id and sub.org_id = r.org_id ${rateFilter}`),
    rateParam && rateParam !== 'new' && isUuid(rateParam)
      ? db.execute(sql`${rateSelect}
          where r.org_id = ${orgId} and r.id = ${rateParam} and r.is_active and r.employee_party_id is null
            ${subsidiaryUiEnabled ? sql`` : sql`and r.subsidiary_id is null`}
          limit 1`)
      : Promise.resolve({ rows: [] }),
    db.execute(sql`select id, name from trades where org_id = ${orgId} and is_active order by name`),
    db.execute(sql`select id, name from departments where org_id = ${orgId} and is_active order by name`),
    db.execute(sql`select id, name, base_currency as currency from subsidiaries where org_id = ${orgId} and is_active and not is_elimination order by parent_id nulls first, name`),
    db.execute(sql`select distinct job_title as name from employee_roles where org_id = ${orgId} and is_active and nullif(trim(job_title), '') is not null order by job_title`),
    db.execute(sql`
      select id, number, name from accounts
       where org_id = ${orgId} and is_active and not is_summary order by number nulls last, name`),
    db.execute(sql`select settings->'controlAccounts' as c, base_currency from orgs where id = ${orgId}`),
    db.execute(sql`
      with active_emp as (
        select p.id, er.job_title, er.trade_id, er.department_id, p.subsidiary_id from parties p
        join employee_roles er on er.party_id = p.id and er.org_id = ${orgId} and er.is_active
       where p.org_id = ${orgId} and p.is_active
      ),
      current_rates as (
        select employee_party_id, job_title, trade_id, department_id, subsidiary_id from labor_cost_rates
         where org_id = ${orgId} and is_active and effective_from <= ${today}
           and (effective_to is null or effective_to >= ${today})
      )
      select
        (select count(*) from active_emp) as employees,
        (select count(*) from active_emp e where
           exists (select 1 from current_rates r where r.employee_party_id = e.id)
           or exists (select 1 from current_rates r where r.employee_party_id is null and lower(r.job_title) = lower(e.job_title) and r.job_title is not null)
           or exists (select 1 from current_rates r where r.employee_party_id is null and r.trade_id = e.trade_id and r.trade_id is not null)
           or exists (select 1 from current_rates r where r.employee_party_id is null and r.department_id = e.department_id and r.department_id is not null)
           or exists (select 1 from current_rates r where r.employee_party_id is null and r.subsidiary_id = e.subsidiary_id and r.subsidiary_id is not null)
           or exists (select 1 from current_rates r where num_nonnulls(r.employee_party_id, r.job_title, r.trade_id, r.department_id, r.subsidiary_id) = 0)
        ) as covered,
        exists (select 1 from current_rates where num_nonnulls(employee_party_id, job_title, trade_id, department_id, subsidiary_id) = 0) as has_org_default`),
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
  const allSubsidiaryOptions = (subsidiariesRes as unknown as { rows: Record<string, unknown>[] }).rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    currency: String(row.currency),
  }))
  const subsidiaryOptions = subsidiaryUiEnabled ? allSubsidiaryOptions : []
  const currencies = Array.from(new Set([org.base_currency, ...subsidiaryOptions.map((row) => row.currency)])).sort()
  const guideHref = mergeHref(BASE, sp, {
    guide: 'setup',
    rate: undefined,
  })

  return {
    title: t('setup.laborCosting.title'),
    description: t('setup.laborCosting.description'),
    guideHref,
    guideLabel: t('setup.laborCosting.checklist.launchWizard'),
    docsLabel: t('setup.laborCosting.docs'),
    overheadLabel: t('setup.entities.overhead-model.title'),
    tabs: VIEWS.map((item) => ({
      href: `${BASE}?view=${item}`,
      label: t(`setup.laborCosting.tabs.${item}`),
      active: view === item,
    })),
    currentParams: sp,
    view,
    settings,
    rates: (ratesRes as unknown as { rows: RateRow[] }).rows,
    selectedRate: (selectedRateRes as unknown as { rows: RateRow[] }).rows[0] ?? null,
    creatingRate,
    guideOpen: pickString(sp.guide) === 'setup',
    totalRates: Number((rateCountRes as unknown as { rows: { n: number }[] }).rows[0]?.n ?? 0),
    ratePage: list.page,
    ratePerPage: list.perPage,
    trades: (tradesRes as unknown as { rows: Record<string, unknown>[] }).rows.map(opt),
    departments: (departmentsRes as unknown as { rows: Record<string, unknown>[] }).rows.map(opt),
    subsidiaries: subsidiaryOptions,
    defaultSubsidiary: allSubsidiaryOptions[0] ?? null,
    jobTitles: (jobTitlesRes as unknown as { rows: { name: string }[] }).rows.map((row) => row.name),
    accounts: (accountsRes as unknown as { rows: Record<string, unknown>[] }).rows.map((r) => ({
      id: String(r.id),
      label: r.number ? `${r.number} · ${r.name}` : String(r.name ?? ''),
    })),
    currencies,
    orgCurrency: org.base_currency,
    laborWip: control.laborWip ?? null,
    laborClearing: control.laborClearing ?? null,
    payrollVariance: control.payrollVariance ?? null,
    coverage: {
      employees: Number(coverageRow.employees),
      covered: Number(coverageRow.covered),
      hasOrgDefault: coverageRow.has_org_default === true,
    },
  }
}

const f = ref<LaborCostingData>()

export function laborCostingSpec(data: LaborCostingData): PageSpec {
  return page({
    route: '/admin/setup/labor-costing',
    // The setup workspace renders its own shell around every entity page;
    // wrapping it in a second page layout would nest the chrome.
    layout: 'bare',
    header: [],
    body: [
      grid('space-y-4', [
        grid('flex flex-wrap items-start justify-between gap-3', [
          // Bare div: the native wrapper carries no class.
          grid(undefined, [
            heading(2, f('title'), 'text-base font-semibold text-slate-900 dark:text-slate-100'),
            textBlock(f('description'), { className: 'max-w-4xl text-sm text-slate-500 dark:text-slate-400' }),
          ]),
          widgetBlock('labor-costing-header-actions', {
            guideHref: data.guideHref,
            guideLabel: data.guideLabel,
            docsLabel: data.docsLabel,
            overheadLabel: data.overheadLabel,
          }),
        ]),
        widgetBlock('labor-costing-tabs', { tabs: data.tabs }),
        widgetBlock('labor-costing-workspace', {
          view: data.view,
          settings: data.settings,
          rates: data.rates,
          selectedRate: data.selectedRate,
          creatingRate: data.creatingRate,
          guideOpen: data.guideOpen,
          currentParams: data.currentParams,
          totalRates: data.totalRates,
          ratePage: data.ratePage,
          ratePerPage: data.ratePerPage,
          trades: data.trades,
          departments: data.departments,
          subsidiaries: data.subsidiaries,
          defaultSubsidiary: data.defaultSubsidiary,
          jobTitles: data.jobTitles,
          accounts: data.accounts,
          currencies: data.currencies,
          orgCurrency: data.orgCurrency,
          laborWip: data.laborWip,
          laborClearing: data.laborClearing,
          payrollVariance: data.payrollVariance,
          coverage: data.coverage,
        }),
      ]),
    ],
  })
}
