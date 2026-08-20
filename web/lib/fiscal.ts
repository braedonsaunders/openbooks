import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { fiscalContextFor, fiscalYearOf, type FiscalContext } from '@openbooks/reports'
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
export { fiscalYearOf, fiscalYearRangeFor } from '@openbooks/reports'

/** The org's fiscal position (current FY / FYTD / quarter / PYTD) as of `today`. */
export async function orgFiscalContext(
  today = new Date().toISOString().slice(0, 10),
  orgId?: string,
): Promise<FiscalContext> {
  return fiscalContextFor(today, await fiscalStartMonth(orgId))
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

/** The current fiscal year (end year) for today, per the org's start month. */
export async function currentFiscalYear(
  today = new Date().toISOString().slice(0, 10),
  orgId?: string,
): Promise<number> {
  return fiscalYearOf(today, await fiscalStartMonth(orgId))
}
