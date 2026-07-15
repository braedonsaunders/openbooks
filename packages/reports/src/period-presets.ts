// Fiscal-aware relative-period presets — the ~50 named date ranges the report
// filter bar and the custom-report studio both draw from (modelled on
// NetSuite's footer Date/Period dropdown). The list here is the shared enum;
// `resolvePreset` turns a preset id + org fiscal config into a concrete range.
//
// This module is pure (no DB, no clock of its own): callers pass `today` and
// the org `startMonth`. The web layer (web/lib/periods.ts) supplies both and
// can further refine the accounting-period presets against real
// `accounting_periods` rows.

import {
  addDays,
  addMonthsIso,
  fiscalHalfRange,
  fiscalMonthOffset,
  fiscalPeriodRange,
  fiscalQuarterRange,
  fiscalYearOf,
  fiscalYearRangeFor,
  type DateRange,
} from './fiscal-calendar'

export type PeriodPresetGroup =
  | 'fiscal_year'
  | 'fiscal_quarter'
  | 'fiscal_half'
  | 'period'
  | 'calendar'
  | 'rolling'
  | 'days'
  | 'custom'

export type PeriodPreset = {
  id: string
  label: string
  group: PeriodPresetGroup
  /** True for point-in-time presets a balance-sheet-style report reads as "as of". */
  pointInTime?: boolean
}

export const PERIOD_PRESET_GROUP_LABELS: Record<PeriodPresetGroup, string> = {
  fiscal_year: 'Fiscal Year',
  fiscal_quarter: 'Fiscal Quarter',
  fiscal_half: 'Fiscal Half',
  period: 'Period / Month',
  calendar: 'Calendar',
  rolling: 'Rolling',
  days: 'Days',
  custom: 'Custom',
}

/** The ordered, grouped preset catalog. Ids are stable — they persist in URLs
 *  and stored report definitions, so never rename an id (change the label). */
export const PERIOD_PRESETS: PeriodPreset[] = [
  // Fiscal Year
  { id: 'this_fiscal_year', label: 'This Fiscal Year', group: 'fiscal_year' },
  { id: 'this_fiscal_year_to_date', label: 'Fiscal Year to Date', group: 'fiscal_year' },
  { id: 'last_fiscal_year', label: 'Last Fiscal Year', group: 'fiscal_year' },
  { id: 'fiscal_year_before_last', label: 'Fiscal Year Before Last', group: 'fiscal_year' },
  { id: 'next_fiscal_year', label: 'Next Fiscal Year', group: 'fiscal_year' },
  { id: 'three_fiscal_years_ago', label: 'Three Fiscal Years Ago', group: 'fiscal_year' },
  // Fiscal Quarter
  { id: 'this_fiscal_quarter', label: 'This Fiscal Quarter', group: 'fiscal_quarter' },
  { id: 'this_fiscal_quarter_to_date', label: 'Fiscal Quarter to Date', group: 'fiscal_quarter' },
  { id: 'last_fiscal_quarter', label: 'Last Fiscal Quarter', group: 'fiscal_quarter' },
  { id: 'fiscal_quarter_before_last', label: 'Fiscal Quarter Before Last', group: 'fiscal_quarter' },
  { id: 'next_fiscal_quarter', label: 'Next Fiscal Quarter', group: 'fiscal_quarter' },
  { id: 'three_fiscal_quarters_ago', label: 'Three Fiscal Quarters Ago', group: 'fiscal_quarter' },
  { id: 'same_fiscal_quarter_last_year', label: 'Same Fiscal Quarter Last Year', group: 'fiscal_quarter' },
  // Fiscal Half
  { id: 'this_fiscal_half', label: 'This Fiscal Half', group: 'fiscal_half' },
  { id: 'last_fiscal_half', label: 'Last Fiscal Half', group: 'fiscal_half' },
  { id: 'next_fiscal_half', label: 'Next Fiscal Half', group: 'fiscal_half' },
  // Period / Month
  { id: 'this_period', label: 'This Period', group: 'period' },
  { id: 'this_period_to_date', label: 'Period to Date', group: 'period' },
  { id: 'last_period', label: 'Last Period', group: 'period' },
  { id: 'period_before_last', label: 'Period Before Last', group: 'period' },
  { id: 'this_month', label: 'This Month', group: 'period' },
  { id: 'this_month_to_date', label: 'Month to Date', group: 'period' },
  { id: 'last_month', label: 'Last Month', group: 'period' },
  { id: 'month_before_last', label: 'Month Before Last', group: 'period' },
  { id: 'next_month', label: 'Next Month', group: 'period' },
  { id: 'same_month_last_fiscal_year', label: 'Same Month Last Fiscal Year', group: 'period' },
  // Calendar
  { id: 'this_calendar_year', label: 'This Calendar Year', group: 'calendar' },
  { id: 'this_calendar_year_to_date', label: 'Calendar Year to Date', group: 'calendar' },
  { id: 'last_calendar_year', label: 'Last Calendar Year', group: 'calendar' },
  // Rolling / trailing
  { id: 'trailing_3_months', label: 'Trailing 3 Months', group: 'rolling' },
  { id: 'trailing_6_months', label: 'Trailing 6 Months', group: 'rolling' },
  { id: 'trailing_12_months', label: 'Trailing 12 Months', group: 'rolling' },
  { id: 'rolling_quarter', label: 'Rolling Quarter', group: 'rolling' },
  { id: 'rolling_year', label: 'Rolling Year', group: 'rolling' },
  // Days
  { id: 'today', label: 'Today', group: 'days', pointInTime: true },
  { id: 'yesterday', label: 'Yesterday', group: 'days', pointInTime: true },
  { id: 'tomorrow', label: 'Tomorrow', group: 'days', pointInTime: true },
  { id: 'week_to_date', label: 'Week to Date', group: 'days' },
  { id: 'last_7_days', label: 'Last 7 Days', group: 'days' },
  { id: 'last_30_days', label: 'Last 30 Days', group: 'days' },
  { id: 'last_60_days', label: 'Last 60 Days', group: 'days' },
  { id: 'last_90_days', label: 'Last 90 Days', group: 'days' },
  { id: 'next_30_days', label: 'Next 30 Days', group: 'days' },
  // Custom (from/to supplied by the caller)
  { id: 'custom', label: 'Custom…', group: 'custom' },
]

export const PERIOD_PRESET_IDS = PERIOD_PRESETS.map((p) => p.id)
export const DEFAULT_PERIOD_PRESET = 'this_fiscal_year'
export function isPeriodPreset(id: unknown): id is string {
  return typeof id === 'string' && PERIOD_PRESET_IDS.includes(id)
}

export type ResolvePresetInput = {
  startMonth: number
  /** Reference "now" as an ISO `yyyy-mm-dd` string (caller-supplied). */
  today: string
  /** Only used by the `custom` preset. */
  customFrom?: string | null
  customTo?: string | null
}

/** Convert a current (fiscalYear, quarter 1-4) into another by shifting `n`
 *  quarters, carrying across fiscal-year boundaries. */
function shiftQuarter(fy: number, q: number, n: number): [number, number] {
  const idx = fy * 4 + (q - 1) + n
  return [Math.floor(idx / 4), (idx % 4) + 1]
}
function shiftPeriod(fy: number, p: number, n: number): [number, number] {
  const idx = fy * 12 + (p - 1) + n
  return [Math.floor(idx / 12), (idx % 12) + 1]
}

/** Trailing window of `n` months ending on `today` (inclusive). */
function trailingMonths(today: string, n: number, label: string): DateRange {
  return { from: addDays(addMonthsIso(today, -n), 1), to: today, label }
}

/**
 * Resolve a preset id into a concrete inclusive `{ from, to }` window plus a
 * descriptive label (e.g. "FY 2026", "Q2 FY 2026", "2026-07"). Returns `null`
 * for an unknown id or a `custom` preset missing its bounds — callers fall back
 * to a default. `to` doubles as the as-of instant for point-in-time reports.
 */
export function resolvePreset(id: string, input: ResolvePresetInput): DateRange | null {
  const { startMonth, today } = input
  const fy = fiscalYearOf(today, startMonth)
  const curQ = Math.floor(fiscalMonthOffset(today, startMonth) / 3) + 1
  const curH = Math.floor(fiscalMonthOffset(today, startMonth) / 6) + 1
  const curP = fiscalMonthOffset(today, startMonth) + 1
  const y = Number(today.slice(0, 4))
  const toDate = (r: DateRange): DateRange => ({ from: r.from, to: today, label: `${r.label} to date` })

  switch (id) {
    // Fiscal Year
    case 'this_fiscal_year':
      return fiscalYearRangeFor(fy, startMonth)
    case 'this_fiscal_year_to_date':
      return toDate(fiscalYearRangeFor(fy, startMonth))
    case 'last_fiscal_year':
      return fiscalYearRangeFor(fy - 1, startMonth)
    case 'fiscal_year_before_last':
      return fiscalYearRangeFor(fy - 2, startMonth)
    case 'next_fiscal_year':
      return fiscalYearRangeFor(fy + 1, startMonth)
    case 'three_fiscal_years_ago':
      return fiscalYearRangeFor(fy - 3, startMonth)

    // Fiscal Quarter
    case 'this_fiscal_quarter':
      return fiscalQuarterRange(fy, curQ, startMonth)
    case 'this_fiscal_quarter_to_date':
      return toDate(fiscalQuarterRange(fy, curQ, startMonth))
    case 'last_fiscal_quarter': {
      const [f, q] = shiftQuarter(fy, curQ, -1)
      return fiscalQuarterRange(f, q, startMonth)
    }
    case 'fiscal_quarter_before_last': {
      const [f, q] = shiftQuarter(fy, curQ, -2)
      return fiscalQuarterRange(f, q, startMonth)
    }
    case 'next_fiscal_quarter': {
      const [f, q] = shiftQuarter(fy, curQ, 1)
      return fiscalQuarterRange(f, q, startMonth)
    }
    case 'three_fiscal_quarters_ago': {
      const [f, q] = shiftQuarter(fy, curQ, -3)
      return fiscalQuarterRange(f, q, startMonth)
    }
    case 'same_fiscal_quarter_last_year':
      return fiscalQuarterRange(fy - 1, curQ, startMonth)

    // Fiscal Half
    case 'this_fiscal_half':
      return fiscalHalfRange(fy, curH, startMonth)
    case 'last_fiscal_half':
      return curH === 1 ? fiscalHalfRange(fy - 1, 2, startMonth) : fiscalHalfRange(fy, 1, startMonth)
    case 'next_fiscal_half':
      return curH === 2 ? fiscalHalfRange(fy + 1, 1, startMonth) : fiscalHalfRange(fy, 2, startMonth)

    // Period / Month (fiscal period == calendar month for a standard calendar)
    case 'this_period':
    case 'this_month':
      return fiscalPeriodRange(fy, curP, startMonth)
    case 'this_period_to_date':
    case 'this_month_to_date':
      return toDate(fiscalPeriodRange(fy, curP, startMonth))
    case 'last_period':
    case 'last_month': {
      const [f, p] = shiftPeriod(fy, curP, -1)
      return fiscalPeriodRange(f, p, startMonth)
    }
    case 'period_before_last':
    case 'month_before_last': {
      const [f, p] = shiftPeriod(fy, curP, -2)
      return fiscalPeriodRange(f, p, startMonth)
    }
    case 'next_month': {
      const [f, p] = shiftPeriod(fy, curP, 1)
      return fiscalPeriodRange(f, p, startMonth)
    }
    case 'same_month_last_fiscal_year': {
      const [f, p] = shiftPeriod(fy, curP, -12)
      return fiscalPeriodRange(f, p, startMonth)
    }

    // Calendar
    case 'this_calendar_year':
      return { from: `${y}-01-01`, to: `${y}-12-31`, label: String(y) }
    case 'this_calendar_year_to_date':
      return { from: `${y}-01-01`, to: today, label: `${y} to date` }
    case 'last_calendar_year':
      return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31`, label: String(y - 1) }

    // Rolling / trailing
    case 'trailing_3_months':
      return trailingMonths(today, 3, 'Trailing 3 months')
    case 'trailing_6_months':
      return trailingMonths(today, 6, 'Trailing 6 months')
    case 'trailing_12_months':
    case 'rolling_year':
      return trailingMonths(today, 12, 'Trailing 12 months')
    case 'rolling_quarter':
      return trailingMonths(today, 3, 'Rolling quarter')

    // Days
    case 'today':
      return { from: today, to: today, label: today }
    case 'yesterday': {
      const d = addDays(today, -1)
      return { from: d, to: d, label: d }
    }
    case 'tomorrow': {
      const d = addDays(today, 1)
      return { from: d, to: d, label: d }
    }
    case 'week_to_date': {
      // ISO week starts Monday.
      const [wy, wm, wd] = [Number(today.slice(0, 4)), Number(today.slice(5, 7)), Number(today.slice(8, 10))]
      const dow = new Date(Date.UTC(wy, wm - 1, wd)).getUTCDay() // 0=Sun..6=Sat
      const from = addDays(today, -((dow + 6) % 7))
      return { from, to: today, label: 'Week to date' }
    }
    case 'last_7_days':
      return { from: addDays(today, -6), to: today, label: 'Last 7 days' }
    case 'last_30_days':
      return { from: addDays(today, -29), to: today, label: 'Last 30 days' }
    case 'last_60_days':
      return { from: addDays(today, -59), to: today, label: 'Last 60 days' }
    case 'last_90_days':
      return { from: addDays(today, -89), to: today, label: 'Last 90 days' }
    case 'next_30_days':
      return { from: today, to: addDays(today, 30), label: 'Next 30 days' }

    // Custom
    case 'custom': {
      const from = input.customFrom
      const to = input.customTo
      if (!from || !to) return null
      return { from, to, label: `${from} – ${to}` }
    }

    default:
      return null
  }
}
