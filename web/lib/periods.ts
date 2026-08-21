import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  DEFAULT_PERIOD_PRESET,
  isPeriodPreset,
  resolvePreset,
  type DateRange,
} from '@openbooks/reports'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { fiscalStartMonth } from './fiscal'
import { resolveOrgId } from './org-scope'

/**
 * Server-side period resolution. Turns a preset id (from `PERIOD_PRESETS`) plus
 * the org's fiscal start month into a concrete `{ from, to }` window. Pure
 * date-math presets are resolved by `resolvePreset`; the accounting-period
 * family ("This / Last / Period Before Last") is refined against real
 * `accounting_periods` rows when they exist so a non-calendar close (13-period,
 * short periods) is honoured — otherwise it falls back to fiscal-month math.
 */

export type ResolvedPeriod = {
  presetId: string
  from: string
  to: string
  /** Descriptive label for headers/PDF (e.g. "FY 2026", "2026-07"). */
  label: string
}

const PERIOD_FAMILY: Record<string, number> = {
  this_period: 0,
  last_period: -1,
  period_before_last: -2,
}

/** Real accounting-period window shifted `offset` periods from the one holding
 *  `today` (non-adjustment periods only). Null when no periods are configured. */
async function accountingPeriodWindow(
  offset: number,
  today: string,
  orgId: string,
): Promise<DateRange | null> {
  const r = (await db.execute<{ name: string; starts_on: string; ends_on: string }>(sql`
    select name, starts_on::text as starts_on, ends_on::text as ends_on
      from accounting_periods
     where org_id = ${orgId} and is_adjustment = false
     order by starts_on
  `))
  const rows = r.rows
  if (!rows.length) return null
  // Index of the period containing today, else the latest one that has started.
  let idx = rows.findIndex((p) => p.starts_on <= today && today <= p.ends_on)
  if (idx < 0) {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i]!.starts_on <= today) {
        idx = i
        break
      }
    }
  }
  if (idx < 0) idx = 0
  const target = idx + offset
  if (target < 0 || target >= rows.length) return null
  const p = rows[target]!
  return { from: p.starts_on, to: p.ends_on, label: p.name }
}

/**
 * Resolve a period selection into concrete dates. `today` defaults to the
 * organization's business day; callers can pin it for deterministic exports.
 */
export async function resolvePeriod(
  presetId: string | null | undefined,
  opts: { customFrom?: string | null; customTo?: string | null; today?: string; orgId?: string } = {},
): Promise<ResolvedPeriod> {
  const orgId = await resolveOrgId(opts.orgId)
  const today = opts.today ?? await businessToday(orgId)
  const id = isPeriodPreset(presetId) ? presetId! : DEFAULT_PERIOD_PRESET
  const startMonth = await fiscalStartMonth(orgId)

  // Accounting-period-aware presets: prefer real period rows.
  if (id in PERIOD_FAMILY) {
    const win = await accountingPeriodWindow(PERIOD_FAMILY[id]!, today, orgId)
    if (win) return { presetId: id, ...win }
  }
  if (id === 'this_period_to_date') {
    const win = await accountingPeriodWindow(0, today, orgId)
    if (win) return { presetId: id, from: win.from, to: today, label: `${win.label} to date` }
  }

  const range = resolvePreset(id, { startMonth, today, customFrom: opts.customFrom, customTo: opts.customTo })
  if (range) return { presetId: id, ...range }

  // Unknown / incomplete custom → safe default (current fiscal year).
  const fallback = resolvePreset(DEFAULT_PERIOD_PRESET, { startMonth, today })!
  return { presetId: DEFAULT_PERIOD_PRESET, ...fallback }
}
