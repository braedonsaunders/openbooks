import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { PayrollError } from '@openbooks/engine/src/payroll/error.ts'
import { nextPeriodAfter } from "@openbooks/engine/src/payroll/run-calendar.ts";
import { payrollSettings } from "@openbooks/engine/src/payroll/run-setup.ts";
import { payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from "@openbooks/engine/src/payroll/scope.ts";
import { installedPayrollCountries, payrollPopulationRegions } from '@openbooks/engine/src/payroll/readiness.ts'
import { packSlotState, payrollTaxYearForDate } from '@openbooks/engine/src/payroll/packs.ts'
import { add, mulDecimal } from '@openbooks/engine/money'
import { flowRates } from '../fx-presentation'
import {
  missingPayrollControlAccounts,
  type MissingPayrollControlAccount,
} from '../payroll-setup-checklist.ts'
import { payrollYtdMoneyAmounts } from './payroll-money.ts'

/**
 * Payroll module home — one light round trip for the /payroll landing cockpit:
 * per-schedule current-period cards (the page's headline objects), the
 * previous completed period, YTD vitals, and the exception queues. Cheap
 * counts and sums only — the T4127 engine never runs here; period boundaries
 * derive from the SAME nextPeriodAfter the engine uses at run creation, so the
 * card and the Start action always agree.
 */

export interface ScheduleCardRun {
  documentId: string
  documentNumber: string
  runStatus: 'draft' | 'calculated' | 'committed'
  documentStatus: string
  netTotal: string
  employeeCount: number
}

interface PayrollScheduleHomeRow extends Record<string, unknown> {
  id: string
  name: string
  frequency: string
  periods_per_year: number
  anchor_period_end: string
  pay_date_offset_days: number
  is_default: boolean
  active_employees: string
  document_id: string | null
  document_number: string | null
  run_status: string | null
  document_status: string | null
  period_start: string | null
  period_end: string | null
  pay_date: string | null
  net_total: string | null
  employee_count: string | null
}

export interface PayrollScheduleCard {
  id: string
  name: string
  frequency: string
  periodsPerYear: number
  isDefault: boolean
  activeEmployees: number
  /** The period the smart action targets (open run, or the derived next). */
  periodStart: string
  periodEnd: string
  payDate: string
  /** The open (unposted, unvoided) run occupying that period; null → Start. */
  run: ScheduleCardRun | null
}

export interface PreviousRun {
  documentId: string
  documentNumber: string
  scheduleName: string | null
  periodStart: string
  periodEnd: string
  payDate: string
  netTotal: string
  employeeCount: number
  posted: boolean
}

export interface PayrollHome {
  /** Latest current tax year across installed packs; run/YTD counts cover every installed pack's current year. */
  taxYear: number
  activeEmployees: number
  /** Committed runs in the current tax year (Harmony's "30 of 52"). */
  runsThisYear: number
  defaultPeriodsPerYear: number | null
  ytdGross: string
  ytdNet: string
  ytdEmployerCost: string
  nextPayDate: string | null
  schedules: PayrollScheduleCard[]
  previousRun: PreviousRun | null
  inProgressRuns: number
  totalRuns: number
  exceptions: {
    missingProfiles: { id: string; name: string }[]
    missingProfilesTotal: number
    missingWages: { id: string; name: string }[]
    missingWagesTotal: number
  }
  /** Control accounts still unconfigured (setup checklist, pack-driven). */
  missingSettings: MissingPayrollControlAccount[]
}

const EXCEPTION_LIMIT = 6

/**
 * The current tax year of every installed payroll pack, per the PACK's own
 * year definition (HMRC's 6 April, the ATO's 1 July) — never the calendar
 * year, which silently splits one statutory year across two for fiscal-year
 * packs. An undeclared country contributes nothing rather than refusing the
 * whole surface; with no installed pack (or no readable settings) the
 * calendar year stands in, the pre-pack behaviour for pack-less orgs.
 */
async function currentPayrollTaxYears(
  orgId: string,
  payrollBlob: Record<string, unknown>,
  allowedSubsidiaryIds: PayrollSubsidiaryScope,
  today: string,
): Promise<number[]> {
  try {
    const countries = await installedPayrollCountries(orgId, payrollBlob, allowedSubsidiaryIds)
    const years = new Set<number>()
    for (const country of countries) {
      try {
        years.add(payrollTaxYearForDate(country, today).taxYear)
      } catch (error) {
        if (!(error instanceof PayrollError)) throw error
      }
    }
    if (years.size > 0) return [...years].sort((a, b) => a - b)
  } catch (error) {
    // A caller who cannot read payroll settings keeps the calendar year
    // below; anything else is a real defect and still throws.
    if (!(error instanceof PayrollError)) throw error
  }
  return [Number(today.slice(0, 4))]
}

function scheduleScopeFilter(
  orgId: string,
  allowedSubsidiaryIds: PayrollSubsidiaryScope,
): SQL {
  if (allowedSubsidiaryIds == null) return sql``
  const ids = [...allowedSubsidiaryIds]
  if (ids.length === 0) return sql` and false`
  return sql` and coalesce(
    s.subsidiary_id,
    (select root.id from subsidiaries root
      where root.org_id = ${orgId} and root.parent_id is null and root.is_active
      order by root.created_at limit 1)
  ) in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`
}

export async function payrollHome(
  orgId: string,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<PayrollHome> {
  const today = await businessToday(orgId)
  // Raw payroll settings blob (also the installed-pack marker for the
  // checklist walk below) — read up front: the tax-year resolution needs
  // the installed packs before the YTD queries are built.
  const payrollBlob = (await db.execute<{ p: Record<string, unknown> | null }>(sql`
    select settings->'payroll' as p from orgs where id = ${orgId}`)).rows[0]?.p ?? {}
  const taxYears = await currentPayrollTaxYears(orgId, payrollBlob, allowedSubsidiaryIds, today)
  // The headline year is the latest current year across installed packs;
  // the counts below cover every installed pack's current year.
  const taxYear = Math.max(...taxYears)
  const yearList = sql.join(taxYears.map((year) => sql`${year}`), sql`, `)

  const [schedulesRes, prevRes, statsRes, ytdRes, noProfileRes, noWageRes, settings] = (await Promise.all([
    // Active schedules + the latest run (any state) + active-profile counts.
    db.execute<PayrollScheduleHomeRow>(sql`
      select s.id, s.name, s.frequency, s.periods_per_year,
             s.anchor_period_end::text as anchor_period_end, s.pay_date_offset_days, s.is_default,
             coalesce(pc.n, 0) as active_employees,
             lr.document_id, lr.document_number, lr.run_status, lr.document_status,
             lr.period_start, lr.period_end, lr.pay_date, lr.net_total, lr.employee_count
        from pay_schedules s
        left join lateral (
          select count(*) as n from employee_payroll_profiles pr
           join parties p on p.id = pr.employee_party_id and p.org_id = pr.org_id
           where pr.org_id = s.org_id and pr.pay_schedule_id = s.id and pr.is_active
             ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)}) pc on true
        left join lateral (
          select r.document_id, d.document_number, r.run_status, d.status as document_status,
                 r.period_start::text as period_start, r.period_end::text as period_end,
                 r.pay_date::text as pay_date, r.net_total, r.employee_count
           from pay_runs r
            join documents d on d.id = r.document_id and d.org_id = r.org_id
           where r.org_id = s.org_id and r.pay_schedule_id = s.id
             ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
           order by r.period_end desc limit 1) lr on true
       where s.org_id = ${orgId} and s.is_active
         ${scheduleScopeFilter(orgId, allowedSubsidiaryIds)}
       order by s.is_default desc, s.name
    `),
    // Previous completed period — the latest committed (or posted) run.
    db.execute(sql`
      select r.document_id, d.document_number, d.status as document_status, sc.name as schedule_name,
             r.period_start::text as period_start, r.period_end::text as period_end,
             r.pay_date::text as pay_date, r.net_total, r.employee_count
        from pay_runs r
        join documents d on d.id = r.document_id and d.org_id = r.org_id
       left join pay_schedules sc on sc.id = r.pay_schedule_id and sc.org_id = r.org_id
       where r.org_id = ${orgId} and r.run_status = 'committed'
         ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
       order by r.pay_date desc, r.period_end desc limit 1
    `),
    db.execute(sql`
      select
        (select count(*) from employee_payroll_profiles pr
          join parties p on p.id = pr.employee_party_id and p.org_id = pr.org_id
         where pr.org_id = ${orgId} and pr.is_active
           ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)}) as active_employees,
        (select count(*) from pay_runs r
          join documents d on d.id = r.document_id and d.org_id = r.org_id
         where r.org_id = ${orgId} and r.tax_year in (${yearList}) and r.run_status = 'committed'
           ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}) as runs_this_year,
        (select count(*) from pay_runs r join documents d on d.id = r.document_id and d.org_id = r.org_id
          where r.org_id = ${orgId} and d.status in ('draft', 'approved')
            ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}) as in_progress,
        (select count(*) from pay_runs r
          join documents d on d.id = r.document_id and d.org_id = r.org_id
         where r.org_id = ${orgId}
           ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}) as total_runs
    `),
    // YTD = committed stubs for the current tax year of every installed
    // pack (matches the engine's YTD basis), grouped by stub currency and
    // pay date — translated below, never summed raw across currencies.
    db.execute(sql`
      select st.currency_code as currency, st.pay_date::text as pay_date,
             coalesce(sum(st.gross), 0) as gross,
             coalesce(sum(st.net_pay), 0) as net,
             coalesce(sum(st.employer_cost), 0) as employer_cost
        from pay_stubs st
        join pay_runs r on r.document_id = st.pay_run_document_id and r.org_id = st.org_id and r.run_status = 'committed'
        join documents d on d.id = r.document_id and d.org_id = r.org_id
       where st.org_id = ${orgId} and st.tax_year in (${yearList})
         ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
       group by st.currency_code, st.pay_date::text
    `),
    // Active employees with no active payroll profile.
    db.execute(sql`
      select p.id, p.display_name as name, count(*) over () as result_count
        from parties p
        join employee_roles er on er.party_id = p.id and er.org_id = p.org_id and er.is_active
       where p.org_id = ${orgId} and p.is_active
         ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)}
         and not exists (
           select 1 from employee_payroll_profiles pr
            where pr.org_id = p.org_id and pr.employee_party_id = p.id and pr.is_active)
       order by p.display_name
       limit ${EXCEPTION_LIMIT}
    `),
    // Profiled employees with no wage effective today (one-table doctrine:
    // wages live in labor_cost_rates, employee scope).
    db.execute(sql`
      select p.id, p.display_name as name, count(*) over () as result_count
        from employee_payroll_profiles pr
        join parties p on p.id = pr.employee_party_id and p.org_id = pr.org_id
       where pr.org_id = ${orgId} and pr.is_active
         ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)}
         and not exists (
           select 1 from labor_cost_rates w
            where w.org_id = pr.org_id and w.employee_party_id = pr.employee_party_id
              and w.is_active and w.effective_from <= ${today}
              and (w.effective_to is null or w.effective_to >= ${today}))
       order by p.display_name
       limit ${EXCEPTION_LIMIT}
    `),
    payrollSettings(orgId, allowedSubsidiaryIds).catch((error) => {
      if (
        allowedSubsidiaryIds != null
        && error instanceof PayrollError
        && error.message === 'payroll settings not found'
      ) return null
      throw error
    }),
    // Raw payroll settings blob: installed-pack marker for the checklist walk.
    db.execute<{ p: Record<string, unknown> | null }>(sql`
      select settings->'payroll' as p from orgs where id = ${orgId}`),
  ]))

  const schedules: PayrollScheduleCard[] = schedulesRes.rows.map((s) => {
    const latest = s.document_id
      ? {
          documentId: String(s.document_id),
          documentNumber: String(s.document_number),
          runStatus: s.run_status as ScheduleCardRun['runStatus'],
          documentStatus: String(s.document_status),
          netTotal: String(s.net_total),
          employeeCount: Number(s.employee_count),
        }
      : null
    // The latest run is "open" while its document is still draft/approved —
    // posted (and voided) runs hand the card to the next derived period.
    const open = latest && (latest.documentStatus === 'draft' || latest.documentStatus === 'approved')
    let periodStart: string
    let periodEnd: string
    let payDate: string
    if (open && latest) {
      periodStart = String(s.period_start)
      periodEnd = String(s.period_end)
      payDate = String(s.pay_date)
    } else {
      const next = nextPeriodAfter(
        { frequency: s.frequency, anchor_period_end: s.anchor_period_end },
        s.period_end ? String(s.period_end) : null,
      )
      periodStart = next.periodStart
      periodEnd = next.periodEnd
      const end = new Date(`${periodEnd}T00:00:00Z`)
      end.setUTCDate(end.getUTCDate() + Number(s.pay_date_offset_days))
      payDate = end.toISOString().slice(0, 10)
    }
    return {
      id: String(s.id),
      name: String(s.name),
      frequency: String(s.frequency),
      periodsPerYear: Number(s.periods_per_year),
      isDefault: Boolean(s.is_default),
      activeEmployees: Number(s.active_employees),
      periodStart,
      periodEnd,
      payDate,
      run: open ? latest : null,
    }
  })

  const prev = prevRes.rows[0]
  const stats = statsRes.rows[0] ?? {}
  // YTD stubs translate at their pay-date spot into the presentation
  // currency — flows doctrine, same as the customer pipeline. Missing
  // coverage fails closed rather than dropping (or, worse, raw-adding) a
  // currency.
  const ytdFx = await flowRates(
    orgId,
    ytdRes.rows.map((r) => ({ func: (r.currency ?? null) as string | null, date: String(r.pay_date).slice(0, 10) })),
  )
  let ytdGross = '0'
  let ytdNet = '0'
  let ytdEmployerCost = '0'
  for (const r of ytdRes.rows) {
    const rate = ytdFx.rateAt((r.currency ?? null) as string | null, String(r.pay_date).slice(0, 10))
    ytdGross = add(ytdGross, mulDecimal(String(r.gross ?? '0'), rate))
    ytdNet = add(ytdNet, mulDecimal(String(r.net ?? '0'), rate))
    ytdEmployerCost = add(ytdEmployerCost, mulDecimal(String(r.employer_cost ?? '0'), rate))
  }
  const ytdMoney = payrollYtdMoneyAmounts({ gross: ytdGross, net: ytdNet, employer_cost: ytdEmployerCost })
  const defaultSchedule = schedules.find((s) => s.isDefault) ?? schedules[0]

  // Setup checklist: the same packSlotState walk the run
  // pre-flight performs — every statutory slot of every installed pack must
  // resolve to a liability account — plus the two country-free accounts.
  // Legacy CA keys must never drive this banner: a US-only tenant has no
  // CPP/EI slots anywhere in its setup. Slots that do not apply where the
  // org's active payroll works are absent, not demanded: an Ontario-only
  // employer is never told to map Québec accounts here either.
  let missingSettings: MissingPayrollControlAccount[] = []
  if (settings) {
    const installed = await installedPayrollCountries(orgId, payrollBlob, allowedSubsidiaryIds)
    const regions = await payrollPopulationRegions(orgId, allowedSubsidiaryIds)
    const states = await packSlotState(orgId, installed, settings as unknown as Record<string, unknown>, regions)
    missingSettings = missingPayrollControlAccounts({
      wageExpenseAccountId: settings.wageExpenseAccountId,
      netPayAccountId: settings.netPayAccountId,
      slots: states.flatMap((pack) =>
        pack.slots.map((slot) => ({ country: pack.country, key: slot.key, accountId: slot.accountId })),
      ),
    })
  }

  return {
    taxYear,
    activeEmployees: Number(stats.active_employees ?? 0),
    runsThisYear: Number(stats.runs_this_year ?? 0),
    defaultPeriodsPerYear: defaultSchedule?.periodsPerYear ?? null,
    ytdGross: ytdMoney.gross,
    ytdNet: ytdMoney.net,
    ytdEmployerCost: ytdMoney.employerCost,
    nextPayDate: schedules.reduce<string | null>(
      (min, s) => (min === null || s.payDate < min ? s.payDate : min),
      null,
    ),
    schedules,
    previousRun: prev
      ? {
          documentId: String(prev.document_id),
          documentNumber: String(prev.document_number),
          scheduleName: prev.schedule_name ? String(prev.schedule_name) : null,
          periodStart: String(prev.period_start),
          periodEnd: String(prev.period_end),
          payDate: String(prev.pay_date),
          netTotal: String(prev.net_total),
          employeeCount: Number(prev.employee_count),
          posted: prev.document_status === 'posted',
        }
      : null,
    inProgressRuns: Number(stats.in_progress ?? 0),
    totalRuns: Number(stats.total_runs ?? 0),
    exceptions: {
      missingProfiles: noProfileRes.rows.map((r) => ({ id: String(r.id), name: String(r.name) })),
      missingProfilesTotal: Number(noProfileRes.rows[0]?.result_count ?? 0),
      missingWages: noWageRes.rows.map((r) => ({ id: String(r.id), name: String(r.name) })),
      missingWagesTotal: Number(noWageRes.rows[0]?.result_count ?? 0),
    },
    missingSettings,
  }
}
