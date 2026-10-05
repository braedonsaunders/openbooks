'use client'

import { useTranslations } from 'next-intl'
import { Clock, Coins } from 'lucide-react'
import { useMoney } from '@/components/money-provider'
import { CardShell, MetricTile, UnavailableRow, type WidgetCardProps } from './_widget-tiles'
import type { TrueCostWidgetSummary, UtilizationWidgetSummary } from './_metrics-projects'

const UTILIZATION_HREF = '/analytics/utilization'
const TRUE_COST_HREF = '/analytics/true-cost'

/**
 * Render cases for the dashboard widgets extracted from True Cost and Utilization. WidgetCard
 * delegates every widget whose registry entry names this source here.
 */
export function ProjectWidgetCard({ widgetId, data }: WidgetCardProps): React.ReactNode {
  switch (widgetId) {
    case 'kpi-utilization':
      return <UtilizationTile summary={data.utilizationSummary} />
    case 'kpi-overhead-absorption':
      return <AbsorptionTile summary={data.trueCostSummary} />
    default:
      return null
  }
}

function UtilizationTile({ summary }: { summary: WidgetCardProps['data']['utilizationSummary'] }) {
  const t = useTranslations('dashboard')
  if (summary === null || !summary.available) {
    return <MetricTile icon={<Clock size={15} />} label={t('widgets.utilization')} value="—" href={UTILIZATION_HREF} tone="slate" hint={summary?.available === false ? summary.reason : undefined} />
  }
  const v: UtilizationWidgetSummary = summary.value
  const parts = [
    t('projectWidgets.target', { target: v.target }),
    v.anomalyCount > 0 ? t('projectWidgets.anomalies', { count: v.anomalyCount }) : null,
    v.unscheduled > 0 ? t('projectWidgets.unscheduled', { count: v.unscheduled }) : null,
    v.periodLabel,
  ].filter(Boolean)
  return (
    <MetricTile
      icon={<Clock size={15} />}
      label={t('widgets.utilization')}
      value={`${v.companyPct.toFixed(1)}%`}
      href={UTILIZATION_HREF}
      tone={v.companyPct >= v.target ? 'emerald' : 'amber'}
      hint={parts.join(' · ')}
    />
  )
}

function AbsorptionTile({ summary }: { summary: WidgetCardProps['data']['trueCostSummary'] }) {
  const t = useTranslations('dashboard')
  const { money } = useMoney()
  if (summary === null || !summary.available) {
    return <MetricTile icon={<Coins size={15} />} label={t('widgets.overheadAbsorption')} value="—" href={TRUE_COST_HREF} tone="slate" hint={summary?.available === false ? summary.reason : undefined} />
  }
  const v: TrueCostWidgetSummary = summary.value
  // A refused composite still shows absorption: the tile names the refusal
  // instead of hiding the mechanism's own figure.
  const parts = [
    v.gap === null || v.gap === undefined ? null : t('projectWidgets.gap', { amount: money(v.gap) }),
    v.refusal,
    v.absorptionNote,
    v.periodLabel,
  ].filter(Boolean)
  if (v.absorptionPct === null || v.absorptionPct === undefined) {
    return (
      <CardShell title={t('widgets.overheadAbsorption')} icon={<Coins size={14} />} href={TRUE_COST_HREF}>
        <UnavailableRow reason={parts.join(' · ') || v.periodLabel} />
      </CardShell>
    )
  }
  return (
    <MetricTile
      icon={<Coins size={15} />}
      label={t('widgets.overheadAbsorption')}
      value={`${v.absorptionPct.toFixed(1)}%`}
      href={TRUE_COST_HREF}
      tone={v.absorptionPct >= 100 ? 'emerald' : 'amber'}
      hint={parts.join(' · ')}
    />
  )
}
