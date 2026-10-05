'use client'
import { Sparkline } from '@openbooks/ui'
import type { AnalyticsPreviewChart } from '../../../lib/analytics/dashboard-catalog'
import { Donut } from './_ui/charts'
import { Gauge } from './_ui/Gauge'

/** Compact previews compose the same visuals as the owning dashboards. */
export function AnalyticsCardChart({ chart }: { chart: AnalyticsPreviewChart }) {
  if (chart.kind === 'sparkline') return <div className="w-28" title={`${chart.label}: ${chart.from} → ${chart.to}`}>
    <Sparkline points={chart.points} stroke="#0d9488" area className="h-8 w-full" ariaLabel={`${chart.label}: ${chart.from} → ${chart.to}`} />
    <span className="mt-0.5 block truncate text-right text-[9px] text-slate-400">{chart.label}</span>
  </div>
  if (chart.kind === 'gauge') return <div title={`${chart.label}: ${chart.value}/100`}>
    <Gauge value={chart.value} size={64} thickness={7} showTicks={false} showValue={false} goodWhenHigh={chart.goodWhenHigh} ariaLabel={`${chart.label}: ${chart.value}/100`} />
  </div>
  return <div className="w-14" role="img" aria-label={`${chart.label}: ${chart.slices.map((slice) => `${slice.name} ${slice.value}`).join(', ')}`}>
    <Donut compact data={chart.slices} height={40} valueFormat={(value) => String(value)} />
  </div>
}
