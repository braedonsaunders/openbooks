import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { fiscalYearOf } from '@openbooks/reports'

/**
 * Fiscal calendar configuration. The pure calendar math (fiscal year / quarter
 * / period boundaries) lives in `@openbooks/reports` (fiscal-calendar.ts) so it
 * can be shared with the DB-free report engine and unit-tested. This module
 * adds the async, DB-backed pieces: reading the org's configured start month
 * (orgs.settings.fiscalYearStartMonth, 1=Jan … 12=Dec; Rassaun = 4 for April)
 * and the "current fiscal year for today" convenience.
 */

// Re-export the pure helpers so existing `./fiscal` imports keep working.
export { fiscalYearOf, fiscalYearRangeFor } from '@openbooks/reports'

let cached: { startMonth: number } | null = null

export async function fiscalStartMonth(): Promise<number> {
  if (cached) return cached.startMonth
  const r = (await db.execute(
    sql`select coalesce((settings->>'fiscalYearStartMonth')::int, 1) as m from orgs limit 1`,
  )) as unknown as { rows: { m: number }[] }
  const m = r.rows[0]?.m ?? 1
  cached = { startMonth: m >= 1 && m <= 12 ? m : 1 }
  return cached.startMonth
}

/** Invalidate the cache after a settings change. */
export function clearFiscalCache() {
  cached = null
}

/** The current fiscal year (end year) for today, per the org's start month. */
export async function currentFiscalYear(today = new Date().toISOString().slice(0, 10)): Promise<number> {
  return fiscalYearOf(today, await fiscalStartMonth())
}
