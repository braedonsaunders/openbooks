'use client'

import { useTranslations } from 'next-intl'
import { useViewerFormat } from '@/lib/viewer-format'
import { InsightChart } from '@openbooks/analytics/viz'
import { abs as moneyAbs, add as moneyAdd, cmp as moneyCmp, neg as moneyNeg } from '@openbooks/engine/money/money'
import { escapeTooltipHtml, toChartNumber, useAnalyticsMoney } from './format'

/** Loose ECharts option shape — mirrors the analytics package's own alias. */
type EChartsOption = Record<string, unknown>
type ChartParam = {
  axisValue?: string;
  marker?: string;
  seriesName?: string;
  seriesIndex?: number;
  value: number;
  name?: string;
  dataIndex: number;
  percent?: number;
}

/**
 * Themed ECharts builders for the analytics dashboards. Every option uses
 * theme-neutral axis/label colors (slate-400) so it reads on light + dark, and
 * the teal-led categorical palette shared with the insights studio.
 */

const AXIS = '#94a3b8'
const SPLIT = 'rgba(148,163,184,0.15)'
export const PALETTE = ['#0d9488', '#6366f1', '#f59e0b', '#ec4899', '#14b8a6', '#8b5cf6', '#ef4444', '#3b82f6', '#84cc16', '#f97316']
const POS = '#10b981'
const NEG = '#ef4444'

/** Formatters receive canonical money strings from ledger-backed charts as
 * well as numeric values from chart-only series. */
type MoneyLabel = (value: string | number) => string

function useChartMoney(): MoneyLabel {
  const formatMoney = useAnalyticsMoney()
  return (value) => formatMoney(value, { compact: true })
}
const pct = (n: number) => `${(n * 100).toFixed(1)}%`

const baseGrid = { left: 8, right: 12, top: 24, bottom: 8, containLabel: true }
const tooltip = { trigger: 'axis' as const, backgroundColor: 'rgba(15,23,42,0.92)', borderWidth: 0, textStyle: { color: '#f1f5f9', fontSize: 12 } }
/** The shared chart vocabulary, for analytics surfaces that compose their own options. */
export const CHART_THEME = { axis: AXIS, split: SPLIT, tooltip, positive: POS, negative: NEG } as const

function catAxis(data: string[], maxTicks?: number): EChartsOption {
  const axisLabel: Record<string, unknown> = { color: AXIS, fontSize: 10 }
  if (maxTicks !== undefined) axisLabel.interval = tickInterval(data.length, maxTicks)
  return { type: 'category', data, axisLine: { lineStyle: { color: SPLIT } }, axisTick: { show: false }, axisLabel }
}

/**
 * Deterministic category-axis thinning: ECharts' width-dependent
 * auto stride swaps WHICH labels render as the viewport changes, so a tick
 * can read "Aug 24" at one width and "Aug 4" at another. Capping the tick
 * count fixes the stride from the data, stable at every width.
 */
export function tickInterval(labelCount: number, maxTicks: number): number {
  if (!Number.isFinite(maxTicks) || maxTicks < 1) return 0
  return Math.max(0, Math.ceil(labelCount / maxTicks) - 1)
}
function valAxis(money: MoneyLabel, fmt: 'money' | 'pct' | 'raw' = 'money'): EChartsOption {
  return {
    type: 'value',
    axisLine: { show: false },
    splitLine: { lineStyle: { color: SPLIT } },
    axisLabel: { color: AXIS, fontSize: 10, formatter: fmt === 'money' ? (v: number) => money(v) : fmt === 'pct' ? (v: number) => `${v}%` : undefined },
  }
}

/** Chart height. A number is an explicit pixel height; `'fill'` makes the
 * canvas take its parent's height, for fit-to-viewport cockpit panels whose
 * body is already sized by the layout. */
export type ChartHeight = number | 'fill'

export function Chart({ option, height }: { option: EChartsOption; height: ChartHeight }) {
  return <InsightChart option={option} height={height === 'fill' ? undefined : height} />
}

/** A point's y value: category-axis series carry a bare value, value-axis series an [x, y] pair. */
const pointValue = (value: unknown): number | null => {
  const y = Array.isArray(value) ? value[1] : value
  return typeof y === 'number' ? y : null
}

/** Multi-series line / area over month labels, or over numeric x values. */
export function TrendChart({
  labels,
  series,
  height = 200,
  area = false,
  pctAxis = false,
  maxTicks,
  format = 'money',
  xValues,
}: {
  /** The x-axis labels; with `xValues`, the tooltip title of each point. */
  labels: string[]
  /** A null point is a period with no margin to plot: ECharts leaves a gap,
   * never a zero stand-in. */
  series: { name: string; data: (number | null)[]; color?: string; pct?: boolean }[]
  /** Pixel height, or 'fill' to fill a sized parent (dashboard widgets). */
  height?: ChartHeight
  area?: boolean
  pctAxis?: boolean
  /** Cap x-axis ticks to a data-fixed stride; unset keeps ECharts auto. */
  maxTicks?: number
  /** What the values are: money (the default, formatted in the org's
   *  currency) or a plain count (headcount, requests) with no currency sign. */
  format?: 'money' | 'count'
  /**
   * Plot each point at its own x value on a value axis formatted like the
   * series (money or count) instead of evenly spaced labels, joined by
   * straight segments with every point marked: unevenly spaced x values keep
   * their true slopes, and a piecewise-linear quantity reads exactly at each
   * of its points. One value per label.
   */
  xValues?: number[]
}) {
  const money = useChartMoney()
  const { number } = useViewerFormat()
  const count = (value: number | string) => number(Number(value))
  const plain = (value: number | string) => (format === 'count' ? count(value) : money(value))
  const numericX = xValues !== undefined
  const shape = (data: (number | null)[]) => (numericX ? data.map((value, index) => [xValues?.[index] ?? null, value]) : data)
  const option: EChartsOption = {
    grid: baseGrid,
    tooltip: {
      ...tooltip,
      valueFormatter: undefined,
      formatter: (params: ChartParam[]) => {
        const title = numericX ? labels[params[0]?.dataIndex ?? -1] : params[0]?.axisValue
        const rows = params.flatMap((p) => {
          const value = pointValue(p.value)
          if (value === null) return []
          return [`${p.marker} ${escapeTooltipHtml(p.seriesName)}: ${p.seriesIndex != null && series[p.seriesIndex]?.pct ? pct(value) : plain(value)}`]
        })
        return [escapeTooltipHtml(title), ...rows].join('<br/>')
      },
    },
    legend: series.length > 1 ? { top: 0, right: 0, textStyle: { color: AXIS, fontSize: 10 }, itemHeight: 8, itemWidth: 12 } : undefined,
    xAxis: numericX
      ? { ...valAxis(money, format === 'count' ? 'raw' : 'money'), min: 'dataMin', max: 'dataMax', splitLine: { show: false }, axisLine: { lineStyle: { color: SPLIT } } }
      : catAxis(labels, maxTicks),
    yAxis: valAxis(money, pctAxis ? 'pct' : format === 'count' ? 'raw' : 'money'),
    series: series.map((s, i) => ({
      name: s.name,
      type: 'line',
      smooth: !numericX,
      showSymbol: numericX,
      symbolSize: numericX ? 4 : undefined,
      lineStyle: { width: 2, color: s.color ?? PALETTE[i % PALETTE.length] },
      itemStyle: { color: s.color ?? PALETTE[i % PALETTE.length] },
      areaStyle: area ? { opacity: 0.12, color: s.color ?? PALETTE[i % PALETTE.length] } : undefined,
      data: shape(s.pct ? s.data.map((v) => (v === null ? null : pctAxis ? v * 100 : v)) : s.data),
    })),
  }
  return <Chart option={option} height={height} />
}

/** Forecast line: history solid, forecast dashed, confidence band shaded. */
export function ForecastChart({
  labels,
  history,
  forecast,
  low,
  high,
  height = 320,
}: {
  labels: string[]
  history: (number | null)[]
  forecast: (number | null)[]
  low: (number | null)[]
  high: (number | null)[]
  height?: number
}) {
  const money = useChartMoney()
  const t = useTranslations('analytics.charts')
  const bandBase = low.map((v) => (v == null ? null : v))
  const bandSpan = low.map((v, i) => (v == null || high[i] == null ? null : (high[i] as number) - v))
  const option: EChartsOption = {
    grid: { ...baseGrid, top: 30 },
    tooltip: { ...tooltip, formatter: (ps: ChartParam[]) => [escapeTooltipHtml(ps[0]?.axisValue), ...ps.filter((p) => p.value != null && p.seriesName !== '_base' && p.seriesName !== '_band').map((p) => `${p.marker} ${escapeTooltipHtml(p.seriesName)}: ${money(p.value)}`)].join('<br/>') },
    legend: { top: 0, right: 0, data: [t('history'), t('forecast')], textStyle: { color: AXIS, fontSize: 10 }, itemHeight: 8, itemWidth: 12 },
    xAxis: catAxis(labels),
    yAxis: valAxis(money),
    series: [
      { name: '_base', type: 'line', stack: 'band', data: bandBase, lineStyle: { opacity: 0 }, symbol: 'none', silent: true },
      { name: '_band', type: 'line', stack: 'band', data: bandSpan, lineStyle: { opacity: 0 }, areaStyle: { color: 'rgba(13,148,136,0.12)' }, symbol: 'none', silent: true },
      { name: t('history'), type: 'line', smooth: true, showSymbol: false, lineStyle: { width: 2.5, color: PALETTE[0] }, itemStyle: { color: PALETTE[0] }, data: history },
      { name: t('forecast'), type: 'line', smooth: true, showSymbol: true, symbolSize: 5, lineStyle: { width: 2.5, color: PALETTE[1], type: 'dashed' }, itemStyle: { color: PALETTE[1] }, data: forecast },
    ],
  }
  return <Chart option={option} height={height} />
}

/** Horizontal diverging bars (driver/item revenue changes). */
export function DivergingBar({
  labels,
  values,
  height = 220,
}: {
  labels: string[]
  values: number[]
  height?: number
}) {
  const money = useChartMoney()
  const option: EChartsOption = {
    grid: { ...baseGrid, left: 4 },
    tooltip: { ...tooltip, formatter: (ps: ChartParam[]) => `${escapeTooltipHtml(ps[0]?.name)}: ${money(ps[0]?.value ?? 0)}` },
    xAxis: valAxis(money),
    yAxis: { ...catAxis(labels), inverse: true },
    series: [
      {
        type: 'bar',
        data: values.map((v) => ({ value: v, itemStyle: { color: v >= 0 ? POS : NEG, borderRadius: [0, 3, 3, 0] } })),
        barMaxWidth: 18,
        label: { show: true, position: 'right', color: AXIS, fontSize: 9, formatter: (p: ChartParam) => money(p.value) },
      },
    ],
  }
  return <Chart option={option} height={height} />
}

/** Grouped vertical bars (budget vs actual, segment margin comparison). */
export function GroupedBar({
  labels,
  series,
  height = 220,
}: {
  labels: string[]
  series: { name: string; data: number[]; color?: string }[]
  height?: number
}) {
  const money = useChartMoney()
  const option: EChartsOption = {
    grid: baseGrid,
    tooltip: { ...tooltip, valueFormatter: (v: number) => money(v) },
    legend: { top: 0, right: 0, textStyle: { color: AXIS, fontSize: 10 }, itemHeight: 8, itemWidth: 12 },
    xAxis: catAxis(labels),
    yAxis: valAxis(money),
    series: series.map((s, i) => ({
      name: s.name,
      type: 'bar',
      data: s.data,
      barMaxWidth: 22,
      itemStyle: { color: s.color ?? PALETTE[i % PALETTE.length], borderRadius: [3, 3, 0, 0] },
    })),
  }
  return <Chart option={option} height={height} />
}

/** Waterfall / bridge — floating bars from Revenue down to Net Income. */
export function Waterfall({
  steps,
  height = 240,
  magnitudeLabels = false,
}: {
  /** Amounts are numbers, or exact decimal strings when every step has one:
   *  exact steps place each bar with ledger arithmetic and project only the
   *  finished coordinates onto the chart, so a cascade that pays out the
   *  whole start lands exactly on zero. */
  steps: { label: string; amount: number | string; kind: 'start' | 'deduct' | 'subtotal' | 'total'; color?: string }[]
  height?: number
  /** Label each deduction by its size rather than its sign: a payout cascade
   *  reads "$4.0M to Series A", not a negative amount. The value axis keeps
   *  its signs. */
  magnitudeLabels?: boolean
}) {
  const chartMoney = useChartMoney()
  const money: MoneyLabel = magnitudeLabels
    ? (value) => chartMoney(typeof value === 'number' ? Math.abs(value) : value.replace(/^-/, ''))
    : chartMoney
  const { base, bar, colors } = waterfallBars(steps)
  const option: EChartsOption = {
    grid: baseGrid,
    tooltip: { ...tooltip, formatter: (ps: ChartParam[]) => `${escapeTooltipHtml(ps[0]?.axisValue)}: ${money(steps[ps[0]?.dataIndex ?? -1]?.amount ?? 0)}` },
    xAxis: catAxis(steps.map((s) => s.label)),
    yAxis: valAxis(chartMoney),
    series: [
      { type: 'bar', stack: 'wf', data: base.map((v) => ({ value: v, itemStyle: { color: 'transparent' } })), silent: true },
      {
        type: 'bar',
        stack: 'wf',
        data: bar.map((v, i) => ({ value: v, itemStyle: { color: colors[i], borderRadius: 3 } })),
        barMaxWidth: 40,
        label: { show: true, position: 'top', color: AXIS, fontSize: 9, formatter: (p: ChartParam) => money(steps[p.dataIndex]?.amount ?? 0) },
      },
    ],
  }
  return <Chart option={option} height={height} />
}

/** A step's own `color` (a series identity the caller keeps stable across charts) wins over the kind's default. */
type WaterfallStepInput = { amount: number | string; kind: 'start' | 'deduct' | 'subtotal' | 'total'; color?: string }

/** Floating-bar geometry for a bridge: each bar's transparent base, its visible height and its color. */
export function waterfallBars(steps: readonly WaterfallStepInput[]): { base: number[]; bar: number[]; colors: string[] } {
  const base: number[] = []
  const bar: number[] = []
  const colors: string[] = []
  const colorOf = (step: WaterfallStepInput, negative: boolean) => step.color ?? (step.kind === 'deduct' ? '#f59e0b' : step.kind === 'total' ? PALETTE[0]! : negative ? NEG : '#14b8a6')
  if (steps.length > 0 && steps.every((s) => typeof s.amount === 'string')) {
    let running = '0'
    for (const s of steps) {
      const amount = s.amount as string
      if (s.kind === 'deduct') {
        // A deduction floats from the running total down by its size.
        const bottom = moneyAdd(running, amount)
        base.push(toChartNumber(moneyCmp(running, bottom) <= 0 ? running : bottom))
        bar.push(toChartNumber(moneyAbs(amount)))
        running = bottom
      } else {
        base.push(0)
        bar.push(toChartNumber(amount))
        running = amount
      }
      colors.push(colorOf(s, moneyCmp(amount, '0') < 0))
    }
    return { base, bar, colors }
  }
  let running = 0
  for (const s of steps) {
    const amount = typeof s.amount === 'number' ? s.amount : toChartNumber(s.amount)
    if (s.kind === 'deduct') {
      const bottom = running + amount // amount is negative
      base.push(Math.min(running, bottom))
      bar.push(Math.abs(amount))
      running = bottom
    } else {
      base.push(0)
      bar.push(amount)
      running = amount
    }
    colors.push(colorOf(s, amount < 0))
  }
  return { base, bar, colors }
}

/** Donut for revenue mix / variance distribution. */
export function Donut({
  data,
  height = 200,
  valueFormat,
  colors,
  compact = false,
}: {
  data: { name: string; value: number }[]
  height?: ChartHeight
  /** Tooltip value rendering — defaults to money; pass a formatter for non-currency values (e.g. hours). */
  valueFormat?: (v: number) => string
  /** Per-slice color override (positional); falls back to the shared palette. */
  colors?: string[]
  /** Miniature composition preview without a legend in the analytics library. */
  compact?: boolean
}) {
  const money = useChartMoney()
  const fmt = valueFormat ?? money
  const option: EChartsOption = {
    tooltip: { trigger: 'item', backgroundColor: 'rgba(15,23,42,0.92)', borderWidth: 0, textStyle: { color: '#f1f5f9', fontSize: 12 }, formatter: (p: ChartParam) => `${escapeTooltipHtml(p.name)}: ${fmt(p.value)} (${p.percent}%)` },
    legend: { show: !compact, type: 'scroll', orient: 'vertical', right: 0, top: 'center', textStyle: { color: AXIS, fontSize: 10 }, itemHeight: 8, itemWidth: 8 },
    series: [
      {
        type: 'pie',
        radius: compact ? ['58%', '90%'] : ['45%', '72%'],
        center: compact ? ['50%', '50%'] : ['38%', '50%'],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: 'transparent', borderWidth: 2 },
        label: { show: false },
        data: data.map((d, i) => ({ ...d, itemStyle: { color: colors?.[i] ?? PALETTE[i % PALETTE.length] } })),
      },
    ],
  }
  return <Chart option={option} height={height} />
}

/** Labels for the cash-bridge waterfall steps (translated by the caller). */
export interface CashBridgeLabels {
  start: string
  inflows: string
  outflows: string
  projectedEnd: string
}

/** Waterfall bridge: Start → +Inflows → −Outflows → Projected End (the
 * cashflow dashboard's signature chart, shared by analytics and the Cash
 * cockpit — moved verbatim from CashflowView). */
export function cashBridgeOption(startCash: string, inflows: string, outflows: string, end: string, money: MoneyLabel, labels: CashBridgeLabels): EChartsOption {
  // Calculate every bridge position and delta exactly before projecting the
  // completed coordinates into the chart library's bounded numeric domain.
  const afterIn = moneyAdd(startCash, inflows)
  const steps = [
    { label: labels.start, from: '0', to: startCash, color: '#94a3b8' },
    { label: labels.inflows, from: startCash, to: afterIn, color: '#10b981' },
    { label: labels.outflows, from: afterIn, to: end, color: '#ef4444' },
    { label: labels.projectedEnd, from: '0', to: end, color: '#0d9488' },
  ]
  const base = steps.map((s) => toChartNumber(moneyCmp(s.from, s.to) <= 0 ? s.from : s.to))
  const bar = steps.map((s) => toChartNumber(moneyAbs(moneyAdd(s.to, moneyNeg(s.from)))))
  const exactValues = [startCash, inflows, moneyNeg(outflows), end]
  return {
    grid: baseGrid,
    tooltip: { ...tooltip, formatter: (ps: ChartParam[]) => `${escapeTooltipHtml(ps[0]?.axisValue)}: ${money(exactValues[ps[0]?.dataIndex ?? -1]!)}` },
    xAxis: catAxis(steps.map((s) => s.label)),
    yAxis: valAxis(money),
    series: [
      { type: 'bar', stack: 'b', data: base.map(() => ({ value: 0, itemStyle: { color: 'transparent' } })), silent: true },
      { type: 'bar', stack: 'b', data: base.map((b) => ({ value: b, itemStyle: { color: 'transparent' } })), silent: true },
      { type: 'bar', stack: 'b', data: bar.map((v, i) => ({ value: v, itemStyle: { color: steps[i]!.color, borderRadius: 3 } })), barMaxWidth: 46, label: { show: true, position: 'top', color: AXIS, fontSize: 9, formatter: (p: ChartParam) => money(exactValues[p.dataIndex]!) } },
    ],
  }
}

/** Labels for the weekly cash-forecast chart (translated by the caller). */
export interface CashForecastLabels {
  endingCash: string
  lowest: string
  in: string
  out: string
  net: string
  ending: string
}

/** Weekly cash-position forecast: teal area over ending cash with a zero
 * guard-line and the lowest week flagged; tooltip breaks each week into
 * in / out / net / ending. */
export function cashForecastOption(
  weeks: { label: string; inflow: string; outflow: string; net: string; endingCash: string }[],
  money: MoneyLabel,
  labels: CashForecastLabels,
): EChartsOption {
  // This conversion is intentionally chart-only. Tooltips retain the exact
  // canonical values from the timeline rows.
  const ending = weeks.map((w) => toChartNumber(w.endingCash))
  const min = Math.min(0, ...ending)
  const lowestIdx = ending.indexOf(Math.min(...ending))
  return {
    grid: baseGrid,
    tooltip: {
      ...tooltip,
      formatter: (ps: ChartParam[]) => {
        const w = weeks[ps[0]?.dataIndex ?? -1]
        if (!w) return ''
        return [
          escapeTooltipHtml(w.label),
          `${labels.in}: ${money(w.inflow)}`,
          `${labels.out}: ${money(w.outflow)}`,
          `${labels.net}: ${money(w.net)}`,
          `<b>${labels.ending}: ${money(w.endingCash)}</b>`,
        ].join('<br/>')
      },
    },
    xAxis: catAxis(weeks.map((w) => w.label.split(' – ')[0]!)),
    yAxis: { ...valAxis(money), min },
    series: [
      {
        name: labels.endingCash,
        type: 'line',
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 2, color: '#0d9488' },
        itemStyle: { color: '#0d9488' },
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(13,148,136,0.28)' },
              { offset: 1, color: 'rgba(13,148,136,0.02)' },
            ],
          },
        },
        data: ending,
        markLine: min < 0
          ? { silent: true, symbol: 'none', lineStyle: { color: NEG, type: 'dashed', width: 1 }, label: { show: false }, data: [{ yAxis: 0 }] }
          : undefined,
        markPoint: {
          symbolSize: 44,
          label: { fontSize: 9, color: '#fff', formatter: (p: ChartParam) => money(p.value) },
          itemStyle: { color: ending[lowestIdx]! < 0 ? NEG : '#f59e0b' },
          data: [{ name: labels.lowest, coord: [lowestIdx, ending[lowestIdx]], value: ending[lowestIdx] }],
        },
      },
    ],
  }
}
