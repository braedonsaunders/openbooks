// Fiscal-aware relative-period presets — the ~50 named date ranges the report
// filter bar and the custom-report studio both draw from (modelled on
// source platform's footer Date/Period dropdown). The list here is the shared enum;
// `resolvePreset` turns a preset id + org fiscal config into a concrete range.
//
// This module is pure (no DB, no clock of its own): callers pass `today` and
// the org `startMonth`. The web layer (web/lib/periods.ts) supplies both and
// can further refine the accounting-period presets against real
// `accounting_periods` rows.

import {
  addDays,
  addMonthsIso,
  declaredPeriodContaining,
  declaredPeriodQuarter,
  declaredQuarterContaining,
  fiscalHalfRange,
  fiscalMonthOffset,
  fiscalPeriodRange,
  fiscalQuarterRange,
  fiscalYearOf,
  fiscalYearRangeFor,
  type DateRange,
  type FiscalPeriod,
  utcCivilDate,
} from './fiscal-calendar'
import type { ReportCustomQuery, ReportRule, ReportRuleGroup } from './types'

/**
 * The org's fiscal position "as of today", with exact inclusive boundaries.
 * Built entirely from `resolvePreset` so any consumer (assistant prompts,
 * agents, UI) states the same windows the report filter bar resolves.
 */
export type FiscalContext = {
  startMonth: number
  /** Current fiscal year, named by the calendar year it ends in. */
  fiscalYear: number
  year: DateRange
  yearToDate: DateRange
  /** Current fiscal quarter number (1-4). */
  quarter: number
  quarterRange: DateRange
  priorYear: DateRange
  /** Same elapsed window one fiscal year earlier (PYTD comparative). */
  priorYearToDate: DateRange
}

export function fiscalContextFor(today: string, startMonth: number): FiscalContext {
  const input = { startMonth, today }
  const year = resolvePreset('this_fiscal_year', input)!
  const priorYear = resolvePreset('last_fiscal_year', input)!
  const fiscalYear = fiscalYearOf(today, startMonth)
  return {
    startMonth,
    fiscalYear,
    year,
    yearToDate: resolvePreset('this_fiscal_year_to_date', input)!,
    quarter: Math.floor(fiscalMonthOffset(today, startMonth) / 3) + 1,
    quarterRange: resolvePreset('this_fiscal_quarter', input)!,
    priorYear,
    priorYearToDate: {
      from: priorYear.from,
      to: addMonthsIso(today, -12),
      label: `${priorYear.label} to date`,
    },
  }
}

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
  /**
   * Declared fiscal periods (default active calendar, non-adjustment) for
   * orgs on a retail/custom calendar. When present, the period/month,
   * quarter, half and fiscal-year families resolve against these instead of
   * calendar math — a 5-week period is one window, labelled with its fiscal
   * name. Any miss falls back to calendar math, and omitting `periods`
   * keeps every preset byte-identical (monthly-cadence orgs take this path).
   */
  periods?: FiscalPeriod[]
}

/** Resolve every stored period_preset leaf into concrete inclusive date bounds.
 *  Callers provide the org-aware resolver so this pure package can be shared by
 *  web report execution and engine allocation drivers without owning a DB. */
export async function resolvePeriodPresetLeaves(
  query: ReportCustomQuery,
  resolveRange: (presetId: string) => Promise<Pick<DateRange, 'from' | 'to'>>,
): Promise<ReportCustomQuery> {
  if (!query.filters) return query
  let touched = false

  const walk = async (node: ReportRuleGroup): Promise<ReportRuleGroup> => {
    const rules: (ReportRule | ReportRuleGroup)[] = []
    for (const rule of node.rules ?? []) {
      if (rule && typeof rule === 'object' && Array.isArray((rule as ReportRuleGroup).rules)) {
        rules.push(await walk(rule as ReportRuleGroup))
        continue
      }
      const leaf = rule as ReportRule
      if (leaf.op !== 'period_preset') {
        rules.push(leaf)
        continue
      }
      touched = true
      const presetId = typeof leaf.value === 'string' ? leaf.value : String(leaf.value ?? '')
      const range = await resolveRange(presetId)
      rules.push({
        combinator: 'and',
        rules: [
          { field: leaf.field, op: 'gte', value: range.from },
          { field: leaf.field, op: 'lte', value: range.to },
        ],
      })
    }
    return { ...node, rules }
  }

  const filters = await walk(query.filters)
  return touched ? { ...query, filters } : query
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
 * Resolve a preset id against declared fiscal periods. Returns null for
 * ids outside the period/month, quarter, half and fiscal-year families, and
 * for any miss (date outside generated periods, ungenerated prior year) —
 * callers fall back to calendar math so a preset never newly resolves null.
 */
function resolveDeclaredPreset(id: string, input: ResolvePresetInput): DateRange | null {
  const periods = [...(input.periods ?? [])].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
  if (!periods.length) return null
  const { today } = input
  const toDate = (r: DateRange): DateRange => ({ from: r.from, to: today, label: `${r.label} to date` })
  const holding = declaredPeriodContaining(periods, today)

  const shiftPeriod = (n: number): DateRange | null => {
    if (!holding) return null
    const idx = periods.findIndex((p) => p === holding)
    const target = periods[idx + n]
    return target ? { from: target.from, to: target.to, label: target.name } : null
  }
  const samePeriodLastYear = (): DateRange | null => {
    if (!holding) return null
    const target = periods.find((p) => p.fiscalYear === holding.fiscalYear - 1 && p.periodNumber === holding.periodNumber)
    return target ? { from: target.from, to: target.to, label: target.name } : null
  }

  // (fiscalYear, quarter) groups ordered by start, with the index holding today.
  const quarterGroups = (): { key: string; from: string; to: string; label: string }[] => {
    const groups = new Map<string, { from: string; to: string }>()
    for (const p of periods) {
      const q = declaredPeriodQuarter(p.periodNumber)
      const g = groups.get(`${p.fiscalYear}:${q}`)
      if (!g) groups.set(`${p.fiscalYear}:${q}`, { from: p.from, to: p.to })
      else {
        if (p.from < g.from) g.from = p.from
        if (p.to > g.to) g.to = p.to
      }
    }
    return [...groups.entries()]
      .map(([key, g]) => {
        const [fy, q] = key.split(':').map(Number)
        return { key, from: g.from, to: g.to, label: `Q${q} FY ${fy}` }
      })
      .sort((a, b) => a.from.localeCompare(b.from))
  }
  const shiftQuarter = (n: number): DateRange | null => {
    const groups = quarterGroups()
    const idx = groups.findIndex((g) => g.from <= today && today <= g.to)
    const target = idx >= 0 ? groups[idx + n] : undefined
    return target ? { from: target.from, to: target.to, label: target.label } : null
  }

  // Halves split each fiscal year's declared periods in two (first half =
  // period numbers up to half the year's count, mirroring the 6/6 calendar
  // split for a 12-period year).
  const halfGroups = (): { key: string; from: string; to: string; label: string }[] => {
    const byYear = new Map<number, FiscalPeriod[]>()
    for (const p of periods) {
      const list = byYear.get(p.fiscalYear) ?? []
      list.push(p)
      byYear.set(p.fiscalYear, list)
    }
    const out: { key: string; from: string; to: string; label: string }[] = []
    for (const [fy, list] of [...byYear.entries()].sort(([a], [b]) => a - b)) {
      const cut = Math.floor(list.length / 2)
      for (const h of [1, 2] as const) {
        const members = h === 1 ? list.filter((p) => p.periodNumber <= cut) : list.filter((p) => p.periodNumber > cut)
        if (!members.length) continue
        const from = members.reduce((a, b) => (a < b.from ? a : b.from), members[0]!.from)
        const to = members.reduce((a, b) => (a > b.to ? a : b.to), members[0]!.to)
        out.push({ key: `${fy}:${h}`, from, to, label: `H${h} FY ${fy}` })
      }
    }
    return out.sort((a, b) => a.from.localeCompare(b.from))
  }
  const shiftHalf = (n: number): DateRange | null => {
    const groups = halfGroups()
    const idx = groups.findIndex((g) => g.from <= today && today <= g.to)
    const target = idx >= 0 ? groups[idx + n] : undefined
    return target ? { from: target.from, to: target.to, label: target.label } : null
  }

  const yearRanges = (): { fy: number; from: string; to: string; label: string }[] => {
    const byYear = new Map<number, { from: string; to: string }>()
    for (const p of periods) {
      const g = byYear.get(p.fiscalYear)
      if (!g) byYear.set(p.fiscalYear, { from: p.from, to: p.to })
      else {
        if (p.from < g.from) g.from = p.from
        if (p.to > g.to) g.to = p.to
      }
    }
    return [...byYear.entries()]
      .map(([fy, g]) => ({ fy, from: g.from, to: g.to, label: `FY ${fy}` }))
      .sort((a, b) => a.from.localeCompare(b.from))
  }
  const shiftYear = (n: number): DateRange | null => {
    const years = yearRanges()
    const current = holding?.fiscalYear ?? fiscalYearOf(today, input.startMonth)
    const idx = years.findIndex((y) => y.fy === current)
    const target = idx >= 0 ? years[idx + n] : undefined
    return target ? { from: target.from, to: target.to, label: target.label } : null
  }

  switch (id) {
    // Fiscal Year
    case 'this_fiscal_year':
      return shiftYear(0)
    case 'this_fiscal_year_to_date': {
      const y = shiftYear(0)
      return y ? toDate(y) : null
    }
    case 'last_fiscal_year':
      return shiftYear(-1)
    case 'fiscal_year_before_last':
      return shiftYear(-2)
    case 'next_fiscal_year':
      return shiftYear(1)
    case 'three_fiscal_years_ago':
      return shiftYear(-3)

    // Fiscal Quarter
    case 'this_fiscal_quarter':
      return declaredQuarterContaining(periods, today)
    case 'this_fiscal_quarter_to_date': {
      const q = declaredQuarterContaining(periods, today)
      return q ? toDate(q) : null
    }
    case 'last_fiscal_quarter':
      return shiftQuarter(-1)
    case 'fiscal_quarter_before_last':
      return shiftQuarter(-2)
    case 'next_fiscal_quarter':
      return shiftQuarter(1)
    case 'three_fiscal_quarters_ago':
      return shiftQuarter(-3)
    case 'same_fiscal_quarter_last_year': {
      const q = declaredQuarterContaining(periods, today)
      if (!q) return null
      const groups = quarterGroups()
      const current = groups.find((g) => g.from <= today && today <= g.to)
      if (!current) return null
      const [fy, n] = current.key.split(':').map(Number)
      const target = groups.find((g) => g.key === `${fy! - 1}:${n}`)
      return target ? { from: target.from, to: target.to, label: target.label } : null
    }

    // Fiscal Half
    case 'this_fiscal_half':
      return shiftHalf(0)
    case 'last_fiscal_half':
      return shiftHalf(-1)
    case 'next_fiscal_half':
      return shiftHalf(1)

    // Period / Month (a fiscal period IS the month for a retail calendar)
    case 'this_period':
    case 'this_month':
      return holding ? { from: holding.from, to: holding.to, label: holding.name } : null
    case 'this_period_to_date':
    case 'this_month_to_date':
      return holding ? toDate({ from: holding.from, to: holding.to, label: holding.name }) : null
    case 'last_period':
    case 'last_month':
      return shiftPeriod(-1)
    case 'period_before_last':
    case 'month_before_last':
      return shiftPeriod(-2)
    case 'next_month':
      return shiftPeriod(1)
    case 'same_month_last_fiscal_year':
      return samePeriodLastYear()

    default:
      return null
  }
}

/**
 * Resolve a preset id into a concrete inclusive `{ from, to }` window plus a
 * descriptive label (e.g. "FY 2026", "Q2 FY 2026", "2026-07"). Returns `null`
 * for an unknown id or a `custom` preset missing its bounds — callers fall back
 * to a default. `to` doubles as the as-of instant for point-in-time reports.
 */
export function resolvePreset(id: string, input: ResolvePresetInput): DateRange | null {
  if (input.periods?.length) {
    const declared = resolveDeclaredPreset(id, input)
    if (declared) return declared
  }
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
      // utcCivilDate keeps literal years 0001-0099 that Date.UTC would remap onto 1900-1999.
      const dow = utcCivilDate(wy, wm - 1, wd).getUTCDay() // 0=Sun..6=Sat
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
