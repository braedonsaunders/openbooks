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
  | { kind: 'empty'; message: string }

const AXIS_TEXT = '#94a3b8' // slate-400 — legible on light + dark
const SPLIT_LINE = 'rgba(148,163,184,0.18)'

/** Series colors — the brand teal leads, then a balanced categorical ramp. */
const PALETTE = ['#0d9488', '#6366f1', '#f59e0b', '#ec4899', '#14b8a6', '#8b5cf6', '#ef4444', '#3b82f6', '#84cc16', '#f97316']

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
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

export function buildVizSpec(result: QueryResult, vizType: VizType, settings: VizSettings = {}): VizSpec {
  if (vizType === 'table') {
    return { kind: 'table', columns: result.columns, rows: result.rows }
  }
  if (result.rows.length === 0) {
    return { kind: 'empty', message: 'No data for this query.' }
  }

  const { category, values } = resolveFields(result, settings)
  if (!category || values.length === 0) {
    return { kind: 'empty', message: 'Pick a dimension and at least one measure to chart this.' }
  }

  const categories = result.rows.map((r) => formatCategory(r[category.key]))

  if (vizType === 'pie') {
    // Pie uses a single measure (the first) over the category.
    const measure = values[0]
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

function formatCategory(v: unknown): string {
  if (v == null) return '—'
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v)
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
 *  the rest of the app uses. */
export function formatCell(value: unknown, type: ResultColumn['type']): string {
  if (value == null || value === '') return '—'
  if (type === 'currency') {
    const n = num(value)
    return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }
  if (type === 'number') {
    const n = num(value)
    return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 })
  }
  if (type === 'date') {
    if (value instanceof Date) return value.toISOString().slice(0, 10)
    return String(value).slice(0, 10)
  }
  return String(value)
}
