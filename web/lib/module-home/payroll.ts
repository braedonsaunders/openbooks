import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { nextPeriodAfter, payrollSettings } from '@openbooks/engine/src/payroll-run.ts'

/**
 * Payroll module home — one light round trip for the /payroll landing cockpit:
 * per-schedule current-period cards (the page's headline objects), the
 * previous completed period, YTD vitals, and the exception queues. Cheap
 * counts and sums only — the T4127 engine never runs here; period boundaries
 * derive from the SAME nextPeriodAfter the engine uses at run creation, so the
 * card and the Start action always agree.
 */

/** Control accounts the commit projection cannot post without. */
export const REQUIRED_PAYROLL_SETTING_KEYS = [
  'wageExpenseAccountId',
  'netPayAccountId',
  'cppPayableAccountId',
  'eiPayableAccountId',
  'taxPayableAccountId',
  'vacationPayableAccountId',
] as const

export interface ScheduleCardRun {
  documentId: string
  documentNumber: string
  runStatus: 'draft' | 'calculated' | 'committed'
  documentStatus: string
  netTotal: string
  employeeCount: number
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
  taxYear: number
  activeEmployees: number
  /** Committed runs in the current tax year (Harmony's "30 of 52"). */
  runsThisYear: number
  defaultPeriodsPerYear: number | null
  ytdGross: number
  ytdNet: number
  ytdEmployerCost: number
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
  /** Control accounts still unconfigured (setup checklist). */
  missingSettings: string[]
}

const EXCEPTION_LIMIT = 6

export async function payrollHome(orgId: string): Promise<PayrollHome> {
  const taxYear = new Date().getUTCFullYear()

  const [schedulesRes, prevRes, statsRes, ytdRes, noProfileRes, noWageRes, settings] = (await Promise.all([
    // Active schedules + the latest run (any state) + active-profile counts.
    db.execute(sql`
      select s.id, s.name, s.frequency, s.periods_per_year,
             s.anchor_period_end::text as anchor_period_end, s.pay_date_offset_days, s.is_default,
             coalesce(pc.n, 0) as active_employees,
             lr.document_id, lr.document_number, lr.run_status, lr.document_status,
             lr.period_start, lr.period_end, lr.pay_date, lr.net_total, lr.employee_count
        from pay_schedules s
        left join lateral (
          select count(*) as n from employee_payroll_profiles pr
           where pr.org_id = s.org_id and pr.pay_schedule_id = s.id and pr.is_active) pc on true
        left join lateral (
          select r.document_id, d.document_number, r.run_status, d.status as document_status,
                 r.period_start::text as period_start, r.period_end::text as period_end,
                 r.pay_date::text as pay_date, r.net_total, r.employee_count
            from pay_runs r
            join documents d on d.id = r.document_id
           where r.org_id = s.org_id and r.pay_schedule_id = s.id
           order by r.period_end desc limit 1) lr on true
       where s.org_id = ${orgId} and s.is_active
       order by s.is_default desc, s.name
    `),
    // Previous completed period — the latest committed (or posted) run.
    db.execute(sql`
      select r.document_id, d.document_number, d.status as document_status, sc.name as schedule_name,
             r.period_start::text as period_start, r.period_end::text as period_end,
             r.pay_date::text as pay_date, r.net_total, r.employee_count
        from pay_runs r
        join documents d on d.id = r.document_id
        left join pay_schedules sc on sc.id = r.pay_schedule_id
       where r.org_id = ${orgId} and r.run_status = 'committed'
       order by r.pay_date desc, r.period_end desc limit 1
    `),
    db.execute(sql`
      select
        (select count(*) from employee_payroll_profiles where org_id = ${orgId} and is_active) as active_employees,
        (select count(*) from pay_runs where org_id = ${orgId} and tax_year = ${taxYear} and run_status = 'committed') as runs_this_year,
        (select count(*) from pay_runs r join documents d on d.id = r.document_id
          where r.org_id = ${orgId} and d.status = 'draft') as in_progress,
        (select count(*) from pay_runs where org_id = ${orgId}) as total_runs
    `),
    // YTD = committed stubs for the current tax year (matches the engine's YTD basis).
    db.execute(sql`
      select coalesce(sum(st.gross), 0) as gross,
             coalesce(sum(st.net_pay), 0) as net,
             coalesce(sum(st.employer_cost), 0) as employer_cost
        from pay_stubs st
        join pay_runs r on r.document_id = st.pay_run_document_id and r.run_status = 'committed'
       where st.org_id = ${orgId} and st.tax_year = ${taxYear}
    `),
    // Active employees with no active payroll profile.
    db.execute(sql`
      select p.id, p.display_name as name, count(*) over () as total
        from parties p
        join employee_roles er on er.party_id = p.id and er.org_id = p.org_id and er.is_active
       where p.org_id = ${orgId} and p.is_active
         and not exists (
           select 1 from employee_payroll_profiles pr
            where pr.org_id = p.org_id and pr.employee_party_id = p.id and pr.is_active)
       order by p.display_name
       limit ${EXCEPTION_LIMIT}
    `),
    // Profiled employees with no wage effective today (one-table doctrine:
    // wages live in labor_cost_rates, employee scope).
    db.execute(sql`
      select p.id, p.display_name as name, count(*) over () as total
        from employee_payroll_profiles pr
        join parties p on p.id = pr.employee_party_id and p.org_id = pr.org_id
       where pr.org_id = ${orgId} and pr.is_active
         and not exists (
           select 1 from labor_cost_rates w
            where w.org_id = pr.org_id and w.employee_party_id = pr.employee_party_id
              and w.is_active and w.effective_from <= current_date
              and (w.effective_to is null or w.effective_to >= current_date))
       order by p.display_name
       limit ${EXCEPTION_LIMIT}
    `),
    payrollSettings(orgId),
  ])) as unknown as [
    { rows: any[] }, { rows: any[] }, { rows: any[] }, { rows: any[] }, { rows: any[] }, { rows: any[] },
    Awaited<ReturnType<typeof payrollSettings>>,
  ]

  const schedules: PayrollScheduleCard[] = schedulesRes.rows.map((s: any) => {
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
  const ytd = ytdRes.rows[0] ?? {}
  const defaultSchedule = schedules.find((s) => s.isDefault) ?? schedules[0]

  return {
    taxYear,
    activeEmployees: Number(stats.active_employees ?? 0),
    runsThisYear: Number(stats.runs_this_year ?? 0),
    defaultPeriodsPerYear: defaultSchedule?.periodsPerYear ?? null,
    ytdGross: Number(ytd.gross ?? 0),
    ytdNet: Number(ytd.net ?? 0),
    ytdEmployerCost: Number(ytd.employer_cost ?? 0),
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
      missingProfiles: noProfileRes.rows.map((r: any) => ({ id: String(r.id), name: String(r.name) })),
      missingProfilesTotal: Number(noProfileRes.rows[0]?.total ?? 0),
      missingWages: noWageRes.rows.map((r: any) => ({ id: String(r.id), name: String(r.name) })),
      missingWagesTotal: Number(noWageRes.rows[0]?.total ?? 0),
    },
    missingSettings: REQUIRED_PAYROLL_SETTING_KEYS.filter((key) => !settings[key]),
  }
}
