import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'

/**
 * Fiscal calendar configuration. The fiscal year start month is an org
 * setting (orgs.settings.fiscalYearStartMonth, 1=Jan … 12=Dec; Rassaun = 4
 * for April). Everything fiscal-year-aware reads it here so the whole app is
 * configurable, never hardcoded to a calendar year.
 */

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

/** The fiscal year (named by its END calendar year) that a date falls in. */
export function fiscalYearOf(dateIso: string, startMonth: number): number {
  const y = Number(dateIso.slice(0, 4))
  const m = Number(dateIso.slice(5, 7))
  // A fiscal year is named by the calendar year it ENDS in. With a Jan start
  // the fiscal year == the calendar year. Otherwise months at/after the start
  // month belong to the year that ends next calendar year.
  if (startMonth === 1) return y
  return m >= startMonth ? y + 1 : y
}

/** Start/end ISO dates + label for a fiscal year (named by end year). */
export function fiscalYearRangeFor(fyEndYear: number, startMonth: number) {
  if (startMonth === 1) {
    return { from: `${fyEndYear}-01-01`, to: `${fyEndYear}-12-31`, label: `FY ${fyEndYear}` }
  }
  const startYear = fyEndYear - 1
  const from = `${startYear}-${String(startMonth).padStart(2, '0')}-01`
  // end = day before the start month, one year later
  const endMonth = startMonth - 1
  const lastDay = new Date(Date.UTC(fyEndYear, endMonth, 0)).getUTCDate()
  return { from, to: `${fyEndYear}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`, label: `FY ${fyEndYear}` }
}

/** The current fiscal year (end year) for today, per the org's start month. */
export async function currentFiscalYear(today = new Date().toISOString().slice(0, 10)): Promise<number> {
  return fiscalYearOf(today, await fiscalStartMonth())
}
