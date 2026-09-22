import 'server-only'
import { sql } from 'drizzle-orm'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { fiscalContextFor, fiscalYearOf, type FiscalContext, type FiscalPeriod } from '@openbooks/reports'
import { resolveOrgId } from './org-scope'

/**
 * Fiscal calendar configuration. The pure calendar math (fiscal year / quarter
 * / period boundaries) lives in `@openbooks/reports` (fiscal-calendar.ts) so it
 * can be shared with the DB-free report engine and unit-tested. This module
 * adds the async, DB-backed pieces: reading the org's configured start month
 * (orgs.settings.fiscalYearStartMonth, 1=Jan … 12=Dec)
 * and the "current fiscal year for today" convenience.
 */

// Re-export the pure helpers so existing `./fiscal` imports keep working.
export { fiscalYearOf, fiscalYearRangeFor, fiscalYearStartOn, priorFiscalYearEndOn } from '@openbooks/reports'

/** The org's fiscal position (current FY / FYTD / quarter / PYTD) as of `today`. */
export async function orgFiscalContext(
  today?: string,
  orgId?: string,
): Promise<FiscalContext> {
  const asOf = today ?? await orgBusinessDay(orgId)
  return fiscalContextFor(asOf, await fiscalStartMonth(orgId))
}

export async function fiscalStartMonth(orgId?: string): Promise<number> {
  const activeOrgId = await resolveOrgId(orgId)
  const r = (await db.execute<{ m: number }>(
    sql`select coalesce((settings->>'fiscalYearStartMonth')::int, 1) as m
          from orgs
         where id = ${activeOrgId}`,
  ))
  const m = r.rows[0]?.m ?? 1
  return m >= 1 && m <= 12 ? m : 1
}

/**
 * The default active fiscal calendar's cadence plus its non-adjustment
 * declared periods (ordered by start). Null when the org has no default
 * active calendar. Shared by statement breakouts and period resolution so
 * every surface reads the same declared periods. Adjustment periods are
 * excluded: the adjustment day intentionally coincides with the final
 * regular day and must never become its own breakout column.
 */
export async function defaultFiscalCalendarPeriods(
  orgId?: string,
): Promise<{ cadence: string; periods: FiscalPeriod[] } | null> {
  const activeOrgId = await resolveOrgId(orgId)
  const cal = (await db.execute<{ cadence: string }>(sql`
    select cadence from fiscal_calendars
     where org_id = ${activeOrgId} and is_default and is_active
     order by created_at limit 1`))
  const cadence = cal.rows[0]?.cadence
  if (!cadence) return null
  const r = (await db.execute<{
    fiscal_year: number
    period_number: number
    name: string
    starts_on: string
    ends_on: string
  }>(sql`
    select p.fiscal_year, p.period_number, p.name,
           p.starts_on::text as starts_on, p.ends_on::text as ends_on
      from accounting_periods p
      join fiscal_calendars fc on fc.id = p.fiscal_calendar_id and fc.org_id = p.org_id
     where p.org_id = ${activeOrgId} and fc.is_default and fc.is_active and not p.is_adjustment
     order by p.starts_on, p.ends_on`))
  return {
    cadence,
    periods: r.rows.map((p) => ({
      fiscalYear: p.fiscal_year,
      periodNumber: p.period_number,
      name: p.name,
      from: p.starts_on,
      to: p.ends_on,
    })),
  }
}

async function orgBusinessDay(orgId?: string): Promise<string> {
  return businessToday(await resolveOrgId(orgId))
}

/** The current fiscal year (end year) for today, per the org's start month. */
export async function currentFiscalYear(
  today?: string,
  orgId?: string,
): Promise<number> {
  const asOf = today ?? await orgBusinessDay(orgId)
  return fiscalYearOf(asOf, await fiscalStartMonth(orgId))
}
