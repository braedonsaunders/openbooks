'use client'

import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { AlertTriangle, Layers, Users } from 'lucide-react'
import { useMoney } from '@/components/money-provider'
import { useViewerFormat } from '@/lib/viewer-format'
import { CardShell, MetricTile, UnavailableRow, type WidgetCardProps } from './_widget-tiles'

const HREF = '/analytics/customer-intelligence'
type MetricTone = Parameters<typeof MetricTile>[0]['tone']
const CONCENTRATION_TONE: Record<'high' | 'moderate' | 'low', MetricTone> = {
  high: 'rose',
  moderate: 'amber',
  low: 'emerald',
}

/**
 * Render cases for the dashboard widgets extracted from Customer
 * Intelligence. WidgetCard delegates every widget whose registry entry
 * names this source here.
 */
export function CustomerWidgetCard({ widgetId, data }: WidgetCardProps): React.ReactNode {
  switch (widgetId) {
    case 'kpi-customer-concentration':
      return <ConcentrationTile concentration={data.concentration} />
    case 'kpi-customers-at-risk':
      return <AtRiskTile atRisk={data.atRisk} />
    case 'list-customers-at-risk':
      return <AtRiskList list={data.atRiskCustomers} />
    default:
      return null
  }
}

function ConcentrationTile({ concentration }: { concentration: WidgetCardProps['data']['concentration'] }) {
  const t = useTranslations('dashboard')
  const { number } = useViewerFormat()
  // No customers in scope means no concentration to state — the tile says
  // why instead of rendering an HHI of 0 that reads as "diversified".
  if (concentration === null || !concentration.available) {
    return <MetricTile icon={<Layers size={15} />} label={t('widgets.customerConcentration')} value="—" href={HREF} tone="slate" hint={concentration?.available === false ? concentration.reason : undefined} />
  }
  const { hhi, level, top5SharePct, period } = concentration.value
  return (
    <MetricTile
      icon={<Layers size={15} />}
      label={t('widgets.customerConcentration')}
      value={t('hhiValue', { value: number(hhi, { maximumFractionDigits: 0 }) })}
      href={HREF}
      tone={CONCENTRATION_TONE[level]}
      hint={t('concentrationHint', { level: t(`concentrationLevels.${level}`), share: number(top5SharePct / 100, { style: 'percent', maximumFractionDigits: 0 }), period })}
    />
  )
}

function AtRiskTile({ atRisk }: { atRisk: WidgetCardProps['data']['atRisk'] }) {
  const t = useTranslations('dashboard')
  const { money } = useMoney()
  // Nobody scored at or above the high-churn bar is a clean book, not a
  // zero to alarm over — the hint names the trailing revenue at stake.
  if (atRisk === null || !atRisk.available) {
    return <MetricTile icon={<Users size={15} />} label={t('widgets.customersAtRisk')} value="—" href={HREF} tone="slate" hint={atRisk?.available === false ? atRisk.reason : undefined} />
  }
  const { count, revenue, period } = atRisk.value
  return (
    <MetricTile
      icon={<Users size={15} />}
      label={t('widgets.customersAtRisk')}
      value={t('atRiskCount', { count })}
      href={HREF}
      tone={count > 0 ? 'amber' : 'emerald'}
      hint={`${money(revenue)} · ${t('atRiskRevenueHint', { period })}`}
    />
  )
}

function AtRiskList({ list }: { list: WidgetCardProps['data']['atRiskCustomers'] }) {
  const t = useTranslations('dashboard')
  const tc = useTranslations('analytics.customer')
  const { money } = useMoney()
  return (
    <CardShell title={t('widgets.atRiskCustomers')} icon={<AlertTriangle size={14} />} href={HREF}>
      {list === null ? <UnavailableRow reason={t('analytics.loading')} /> : !list.available ? (
        <UnavailableRow reason={list.reason} />
      ) : list.value.length === 0 ? (
        <UnavailableRow reason={t('persona.allClear')} />
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {list.value.map((customer) => (
            <li key={customer.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                  <Link href={`/entities/customers?party=${customer.id}`} className="hover:underline">{customer.name}</Link>
                </div>
                <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                  {tc(`risk.${customer.churnLevel}`)} · {t('churnScore', { score: customer.churnScore })}
                </div>
              </div>
              <div className="shrink-0 text-right text-sm font-medium tabular-nums text-slate-700 dark:text-slate-200">
                {money(customer.revenue)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </CardShell>
  )
}
