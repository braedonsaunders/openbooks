'use client'

import { InsightChart } from '@openbooks/analytics/viz'

/** Loose ECharts option shape — mirrors the analytics package's own alias. */
type EChartsOption = Record<string, unknown>

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

const money = (n: number) => {
  const a = Math.abs(n)
  const s = n < 0 ? '-' : ''
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(1)}B`
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(1)}M`
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(0)}K`
  return `${s}$${a.toFixed(0)}`
}
const pct = (n: number) => `${(n * 100).toFixed(1)}%`

const baseGrid = { left: 8, right: 12, top: 24, bottom: 8, containLabel: true }
const tooltip = { trigger: 'axis' as const, backgroundColor: 'rgba(15,23,42,0.92)', borderWidth: 0, textStyle: { color: '#f1f5f9', fontSize: 12 } }

function catAxis(data: string[]): EChartsOption {
  return { type: 'category', data, axisLine: { lineStyle: { color: SPLIT } }, axisTick: { show: false }, axisLabel: { color: AXIS, fontSize: 10 } }
}
function valAxis(fmt: 'money' | 'pct' | 'raw' = 'money'): EChartsOption {
  return {
    type: 'value',
    axisLine: { show: false },
    splitLine: { lineStyle: { color: SPLIT } },
    axisLabel: { color: AXIS, fontSize: 10, formatter: fmt === 'money' ? (v: number) => money(v) : fmt === 'pct' ? (v: number) => `${v}%` : undefined },
  }
}

export function Chart({ option, height }: { option: EChartsOption; height: number }) {
  return <InsightChart option={option} height={height} />
}

/** Multi-series line / area over month labels. */
export function TrendChart({
  labels,
  series,
  height = 200,
  area = false,
  pctAxis = false,
}: {
  labels: string[]
  series: { name: string; data: number[]; color?: string; pct?: boolean }[]
  height?: number
  area?: boolean
  pctAxis?: boolean
}) {
  const option: EChartsOption = {
    grid: baseGrid,
    tooltip: {
      ...tooltip,
      valueFormatter: undefined,
      formatter: (params: any[]) =>
        [params[0]?.axisValue, ...params.map((p) => `${p.marker} ${p.seriesName}: ${p.seriesIndex != null && series[p.seriesIndex]?.pct ? pct(p.value) : money(p.value)}`)].join('<br/>'),
    },
    legend: series.length > 1 ? { top: 0, right: 0, textStyle: { color: AXIS, fontSize: 10 }, itemHeight: 8, itemWidth: 12 } : undefined,
    xAxis: catAxis(labels),
    yAxis: valAxis(pctAxis ? 'pct' : 'money'),
    series: series.map((s, i) => ({
      name: s.name,
      type: 'line',
      smooth: true,
      showSymbol: false,
      lineStyle: { width: 2, color: s.color ?? PALETTE[i % PALETTE.length] },
      itemStyle: { color: s.color ?? PALETTE[i % PALETTE.length] },
      areaStyle: area ? { opacity: 0.12, color: s.color ?? PALETTE[i % PALETTE.length] } : undefined,
      data: s.pct ? s.data.map((v) => (pctAxis ? v * 100 : v)) : s.data,
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
  const bandBase = low.map((v) => (v == null ? null : v))
  const bandSpan = low.map((v, i) => (v == null || high[i] == null ? null : (high[i] as number) - v))
  const option: EChartsOption = {
    grid: { ...baseGrid, top: 30 },
    tooltip: { ...tooltip, formatter: (ps: any[]) => [ps[0]?.axisValue, ...ps.filter((p) => p.value != null && p.seriesName !== '_base' && p.seriesName !== '_band').map((p) => `${p.marker} ${p.seriesName}: ${money(p.value)}`)].join('<br/>') },
    legend: { top: 0, right: 0, data: ['History', 'Forecast'], textStyle: { color: AXIS, fontSize: 10 }, itemHeight: 8, itemWidth: 12 },
    xAxis: catAxis(labels),
    yAxis: valAxis('money'),
    series: [
      { name: '_base', type: 'line', stack: 'band', data: bandBase, lineStyle: { opacity: 0 }, symbol: 'none', silent: true },
      { name: '_band', type: 'line', stack: 'band', data: bandSpan, lineStyle: { opacity: 0 }, areaStyle: { color: 'rgba(13,148,136,0.12)' }, symbol: 'none', silent: true },
      { name: 'History', type: 'line', smooth: true, showSymbol: false, lineStyle: { width: 2.5, color: PALETTE[0] }, itemStyle: { color: PALETTE[0] }, data: history },
      { name: 'Forecast', type: 'line', smooth: true, showSymbol: true, symbolSize: 5, lineStyle: { width: 2.5, color: PALETTE[1], type: 'dashed' }, itemStyle: { color: PALETTE[1] }, data: forecast },
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
  const option: EChartsOption = {
    grid: { ...baseGrid, left: 4 },
    tooltip: { ...tooltip, formatter: (ps: any[]) => `${ps[0]?.name}: ${money(ps[0]?.value)}` },
    xAxis: valAxis('money'),
    yAxis: { ...catAxis(labels), inverse: true },
    series: [
      {
        type: 'bar',
        data: values.map((v) => ({ value: v, itemStyle: { color: v >= 0 ? POS : NEG, borderRadius: [0, 3, 3, 0] } })),
        barMaxWidth: 18,
        label: { show: true, position: 'right', color: AXIS, fontSize: 9, formatter: (p: any) => money(p.value) },
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
  const option: EChartsOption = {
    grid: baseGrid,
    tooltip: { ...tooltip, valueFormatter: (v: number) => money(v) },
    legend: { top: 0, right: 0, textStyle: { color: AXIS, fontSize: 10 }, itemHeight: 8, itemWidth: 12 },
    xAxis: catAxis(labels),
    yAxis: valAxis('money'),
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
}: {
  steps: { label: string; amount: number; kind: 'start' | 'deduct' | 'subtotal' | 'total' }[]
  height?: number
}) {
  // Compute running base for floating bars.
  let running = 0
  const base: number[] = []
  const bar: number[] = []
  const colors: string[] = []
  steps.forEach((s) => {
    if (s.kind === 'start' || s.kind === 'subtotal' || s.kind === 'total') {
      base.push(0)
      bar.push(s.amount)
      running = s.amount
      colors.push(s.kind === 'total' ? PALETTE[0] : s.amount >= 0 ? '#14b8a6' : NEG)
    } else {
      // deduct: floating bar from running down by |amount|
      const top = running
      const bottom = running + s.amount // amount is negative
      base.push(Math.min(top, bottom))
      bar.push(Math.abs(s.amount))
      running = bottom
      colors.push('#f59e0b')
    }
  })
  const option: EChartsOption = {
    grid: baseGrid,
    tooltip: { ...tooltip, formatter: (ps: any[]) => `${ps[0]?.axisValue}: ${money(steps[ps[0]?.dataIndex]?.amount ?? 0)}` },
    xAxis: catAxis(steps.map((s) => s.label)),
    yAxis: valAxis('money'),
    series: [
      { type: 'bar', stack: 'wf', data: base.map((v) => ({ value: v, itemStyle: { color: 'transparent' } })), silent: true },
      {
        type: 'bar',
        stack: 'wf',
        data: bar.map((v, i) => ({ value: v, itemStyle: { color: colors[i], borderRadius: 3 } })),
        barMaxWidth: 40,
        label: { show: true, position: 'top', color: AXIS, fontSize: 9, formatter: (p: any) => money(steps[p.dataIndex]?.amount ?? 0) },
      },
    ],
  }
  return <Chart option={option} height={height} />
}

/** Donut for revenue mix / variance distribution. */
export function Donut({
  data,
  height = 200,
  valueFormat,
  colors,
}: {
  data: { name: string; value: number }[]
  height?: number
  /** Tooltip value rendering — defaults to money; pass a formatter for non-currency values (e.g. hours). */
  valueFormat?: (v: number) => string
  /** Per-slice color override (positional); falls back to the shared palette. */
  colors?: string[]
}) {
  const fmt = valueFormat ?? money
  const option: EChartsOption = {
    tooltip: { trigger: 'item', backgroundColor: 'rgba(15,23,42,0.92)', borderWidth: 0, textStyle: { color: '#f1f5f9', fontSize: 12 }, formatter: (p: any) => `${p.name}: ${fmt(p.value)} (${p.percent}%)` },
    legend: { type: 'scroll', orient: 'vertical', right: 0, top: 'center', textStyle: { color: AXIS, fontSize: 10 }, itemHeight: 8, itemWidth: 8 },
    series: [
      {
        type: 'pie',
        radius: ['45%', '72%'],
        center: ['38%', '50%'],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: 'transparent', borderWidth: 2 },
        label: { show: false },
        data: data.map((d, i) => ({ ...d, itemStyle: { color: colors?.[i] ?? PALETTE[i % PALETTE.length] } })),
      },
    ],
  }
  return <Chart option={option} height={height} />
}

/** Waterfall bridge: Start → +Inflows → −Outflows → Projected End (the
 * cashflow dashboard's signature chart, shared by analytics and the Cash
 * cockpit — moved verbatim from CashflowView). */
export function cashBridgeOption(startCash: number, inflows: number, outflows: number, end: number): EChartsOption {
  const afterIn = startCash + inflows
  const steps = [
    { label: 'Start', from: 0, to: startCash, color: '#94a3b8' },
    { label: 'Inflows', from: startCash, to: afterIn, color: '#10b981' },
    { label: 'Outflows', from: afterIn, to: end, color: '#ef4444' },
    { label: 'Projected End', from: 0, to: end, color: '#0d9488' },
  ]
  const base = steps.map((s) => Math.min(s.from, s.to))
  const bar = steps.map((s) => Math.abs(s.to - s.from))
  return {
    grid: baseGrid,
    tooltip: { ...tooltip, formatter: (ps: any[]) => `${ps[0]?.axisValue}: ${money([startCash, inflows, -outflows, end][ps[0]?.dataIndex])}` },
    xAxis: catAxis(steps.map((s) => s.label)),
    yAxis: valAxis('money'),
    series: [
      { type: 'bar', stack: 'b', data: base.map(() => ({ value: 0, itemStyle: { color: 'transparent' } })), silent: true },
      { type: 'bar', stack: 'b', data: base.map((b) => ({ value: b, itemStyle: { color: 'transparent' } })), silent: true },
      { type: 'bar', stack: 'b', data: bar.map((v, i) => ({ value: v, itemStyle: { color: steps[i]!.color, borderRadius: 3 } })), barMaxWidth: 46, label: { show: true, position: 'top', color: AXIS, fontSize: 9, formatter: (p: any) => money([startCash, inflows, -outflows, end][p.dataIndex]) } },
    ],
  }
}

/** Weekly cash-position forecast: teal area over ending cash with a zero
 * guard-line and the lowest week flagged; tooltip breaks each week into
 * in / out / net / ending. */
export function cashForecastOption(
  weeks: { label: string; inflow: number; outflow: number; net: number; endingCash: number }[],
): EChartsOption {
  const ending = weeks.map((w) => w.endingCash)
  const min = Math.min(0, ...ending)
  const lowestIdx = ending.indexOf(Math.min(...ending))
  return {
    grid: baseGrid,
    tooltip: {
      ...tooltip,
      formatter: (ps: any[]) => {
        const w = weeks[ps[0]?.dataIndex]
        if (!w) return ''
        return [
          w.label,
          `In: ${money(w.inflow)}`,
          `Out: ${money(w.outflow)}`,
          `Net: ${money(w.net)}`,
          `<b>Ending: ${money(w.endingCash)}</b>`,
        ].join('<br/>')
      },
    },
    xAxis: catAxis(weeks.map((w) => w.label.split(' – ')[0]!)),
    yAxis: { ...valAxis('money'), min },
    series: [
      {
        name: 'Ending cash',
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
          label: { fontSize: 9, color: '#fff', formatter: (p: any) => money(p.value) },
          itemStyle: { color: ending[lowestIdx]! < 0 ? NEG : '#f59e0b' },
          data: [{ name: 'Lowest', coord: [lowestIdx, ending[lowestIdx]], value: ending[lowestIdx] }],
        },
      },
    ],
  }
}
