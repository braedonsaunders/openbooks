// Viz spec builder: QueryResult → an ECharts option (or a table plan). Pure —
// no echarts import here, just the plain option object echarts consumes — so it
// is safe on the server (SSR of settings, dashboard thumbnails) and the client.
//
// The card studio persists a `VizType` + `VizSettings`; this maps the executed
// result into what the renderer draws, choosing sensible defaults when settings
// are empty.

import type { QueryResult, ResultColumn, VizSettings, VizType } from './types'

/** Loose ECharts option shape — enough to type the builder without pulling the
 *  echarts type surface into every consumer. */
export type EChartsOption = Record<string, unknown>

export type VizSpec =
  | { kind: 'table'; columns: ResultColumn[]; rows: Record<string, unknown>[] }
  | { kind: 'chart'; chartType: Exclude<VizType, 'table'>; option: EChartsOption }
  /** `reason` is a stable code the renderer translates. */
  | { kind: 'empty'; reason: 'noData' | 'pickFields' }

/** Locale hook for dimension VALUES baked into a chart (category axis, pie
 *  slice names): return a display string for fixed-vocabulary columns
 *  (col.valueKind), or null to keep the raw value. */
export type VizValueFormatter = (col: ResultColumn, value: unknown) => string | null

const AXIS_TEXT = '#94a3b8' // slate-400 — legible on light + dark
const SPLIT_LINE = 'rgba(148,163,184,0.18)'

/** Series colors — the brand teal leads, then a balanced categorical ramp. */
const PALETTE = ['#0d9488', '#6366f1', '#f59e0b', '#ec4899', '#14b8a6', '#8b5cf6', '#ef4444', '#3b82f6', '#84cc16', '#f97316']

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Exact decimal display without a Number hop. Intl.NumberFormat accepts a
 *  decimal STRING and formats it exactly — the same mechanism as the house
 *  formatter web/lib/money-format.ts `formatDecimal` for canonical ledger
 *  strings. Routing through Number() first would round anything past 2^53
 *  (9007199254740993.00 prints …992.00) and cement the error in the grouping.
 *  Returns null when the value is not a plain decimal string. */
function formatDecimalString(
  raw: string,
  minimumFractionDigits: number,
  maximumFractionDigits: number,
): string | null {
  const text = raw.trim()
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits,
    maximumFractionDigits,
    useGrouping: true,
  }).format(text as unknown as number)
}

/** Fraction scale carried by a plain decimal string, or null when it is not
 *  one. Currency cells keep their stored scale (a 3-decimal ledger value
 *  prints 3 places, never forced to 2). */
function decimalScale(raw: string): number | null {
  const match = /^[+-]?(?:\d+(?:\.(\d*))?|\.\d+)$/.exec(raw.trim())
  if (!match) return null
  return match[1]?.length ?? 0
}

function isCurrency(col: ResultColumn | undefined): boolean {
  return col?.type === 'currency'
}

/** Pick the category (dimension) column and the value (measure) columns to plot,
 *  honoring explicit settings and falling back to result roles. */
function resolveFields(result: QueryResult, settings: VizSettings) {
  const dims = result.columns.filter((c) => c.role === 'dimension')
  const measures = result.columns.filter((c) => c.role === 'measure')

  const category =
    result.columns.find((c) => c.key === settings.categoryField) ?? dims[0] ?? result.columns[0]

  const chosen = (settings.valueFields ?? [])
    .map((k) => result.columns.find((c) => c.key === k))
    .filter((c): c is ResultColumn => !!c && c.role === 'measure')
  const values = chosen.length > 0 ? chosen : measures

  return { category, values }
}

export function buildVizSpec(
  result: QueryResult,
  vizType: VizType,
  settings: VizSettings = {},
  formatValue?: VizValueFormatter,
): VizSpec {
  if (vizType === 'table') {
    return { kind: 'table', columns: result.columns, rows: result.rows }
  }
  if (result.rows.length === 0) {
    return { kind: 'empty', reason: 'noData' }
  }

  const { category, values } = resolveFields(result, settings)
  if (!category || values.length === 0) {
    return { kind: 'empty', reason: 'pickFields' }
  }

  const categories = result.rows.map(
    (r) => formatValue?.(category, r[category.key]) ?? formatCategory(category, r[category.key]),
  )

  if (vizType === 'pie') {
    // Pie uses a single measure (the first) over the category.
    const measure = values[0]!
    const data = result.rows.map((r, i) => ({ name: categories[i], value: num(r[measure.key]) }))
    return {
      kind: 'chart',
      chartType: 'pie',
      option: {
        color: PALETTE,
        tooltip: { trigger: 'item' },
        legend: settings.hideLegend ? undefined : { type: 'scroll', bottom: 0, textStyle: { color: AXIS_TEXT } },
        series: [
          {
            type: 'pie',
            radius: ['42%', '68%'],
            avoidLabelOverlap: true,
            itemStyle: { borderColor: 'transparent', borderWidth: 2 },
            label: { show: settings.showValues === true, color: AXIS_TEXT },
            data,
          },
        ],
      },
    }
  }

  // bar | line | area — shared cartesian axes.
  const horizontal = vizType === 'bar' && settings.horizontal === true
  const currencyAxis = values.every((v) => isCurrency(v))

  const catAxis = {
    type: 'category' as const,
    data: categories,
    axisLabel: { color: AXIS_TEXT, hideOverlap: true },
    axisLine: { lineStyle: { color: SPLIT_LINE } },
    axisTick: { show: false },
  }
  const valAxis = {
    type: 'value' as const,
    axisLabel: { color: AXIS_TEXT, formatter: currencyAxis ? compactCurrencyFormatter : undefined },
    splitLine: { lineStyle: { color: SPLIT_LINE } },
  }

  const series = values.map((v, i) => {
    const base: Record<string, unknown> = {
      name: v.label,
      type: vizType === 'bar' ? 'bar' : 'line',
      data: result.rows.map((r) => num(r[v.key])),
      itemStyle: { color: PALETTE[i % PALETTE.length] },
      label: { show: settings.showValues === true, color: AXIS_TEXT },
    }
    if (vizType === 'bar') {
      base.barMaxWidth = 42
      if (settings.stacked) base.stack = 'total'
    } else {
      base.smooth = settings.smooth === true
      base.showSymbol = result.rows.length <= 40
      base.lineStyle = { width: 2 }
      if (vizType === 'area') {
        base.areaStyle = { opacity: settings.stacked ? 0.85 : 0.18 }
        if (settings.stacked) base.stack = 'total'
      }
    }
    return base
  })

  return {
    kind: 'chart',
    chartType: vizType,
    option: {
      color: PALETTE,
      grid: { left: 12, right: 16, top: 24, bottom: settings.hideLegend ? 28 : 44, containLabel: true },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend:
        settings.hideLegend || series.length <= 1
          ? undefined
          : { type: 'scroll', bottom: 0, textStyle: { color: AXIS_TEXT } },
      xAxis: horizontal ? valAxis : catAxis,
      yAxis: horizontal ? catAxis : valAxis,
      series,
    },
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Label a chart category.
 *
 * Two traps live here, and both shipped.
 *
 * FIRST: a date only arrives as a `Date` when the caller ran the query
 * in-process. Every card on a dashboard fetches over HTTP and parses with
 * `res.json()`, which turns it into a STRING — so an `instanceof Date` test is
 * false exactly where users look, and the axis printed a raw
 * `2026-09-01T00:00:00.000Z`. Parse the ISO prefix instead of testing the
 * runtime type.
 *
 * SECOND: a binned bucket is a PERIOD, not the instant it begins on. A month
 * bucket labelled `2026-09-01` reads as a single day. Label it as what it
 * represents.
 */
function formatCategory(col: ResultColumn, v: unknown): string {
  if (v == null) return '—'
  const iso =
    v instanceof Date
      ? v.toISOString().slice(0, 10)
      : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)
        ? v.slice(0, 10)
        : null
  if (iso === null) return String(v)

  const [y, m, d] = iso.split('-')
  const month = MONTHS[Number(m) - 1] ?? m
  switch (col.dateBin) {
    case 'year':
      return y!
    case 'quarter':
      return `Q${Math.floor((Number(m) - 1) / 3) + 1} ${y}`
    case 'month':
      return `${month} ${y}`
    case 'week':
    case 'day':
      return `${month} ${Number(d)}, ${y}`
    default:
      // Unbinned date dimension: the day itself is the value.
      return col.type === 'date' ? `${month} ${Number(d)}, ${y}` : iso
  }
}

// Serializable formatter reference — ECharts calls it at render time. A named
// function so it survives structured passing through the client boundary as a
// value (the renderer re-attaches it; see note in the client component).
function compactCurrencyFormatter(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${(value / 1_000).toFixed(0)}k`
  return String(value)
}

/** Cell formatting for the table renderer — mirrors the money/number/date rules
 *  the rest of the app uses. Money arrives from pg as exact decimal strings
 *  (numeric → string); those strings are formatted EXACTLY — never through
 *  Number(), which cannot represent them past 2^53. */
export function formatCell(value: unknown, type: ResultColumn['type']): string {
  if (value == null || value === '') return '—'
  if (type === 'currency') {
    if (typeof value === 'string') {
      const scale = decimalScale(value)
      if (scale !== null) {
        // Ledger scale is preserved: 2-place values print 2 places, a
        // 3-decimal currency prints 3 — never truncated to a 2-dp shape the
        // ledger never held.
        return formatDecimalString(value, 2, Math.max(2, scale)) ?? String(value)
      }
    }
    if (typeof value === 'bigint') {
      return new Intl.NumberFormat(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
        useGrouping: true,
      }).format(value)
    }
    const n = num(value)
    return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }
  if (type === 'number') {
    if (typeof value === 'string') {
      const exact = formatDecimalString(value, 0, 2)
      if (exact !== null) return exact
    }
    const n = num(value)
    return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 })
  }
  if (type === 'date') {
    if (value instanceof Date) return value.toISOString().slice(0, 10)
    return String(value).slice(0, 10)
  }
  return String(value)
}
