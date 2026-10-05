'use client'

import { useTranslations } from 'next-intl'
import { Flame, RefreshCw, ShieldCheck, TrendingDown } from 'lucide-react'
import { useMoney } from '@/components/money-provider'
import { useViewerFormat } from '@/lib/viewer-format'
import { formatExactRatio } from '../analytics/_ui/format'
import { MetricTile, type WidgetCardProps } from './_widget-tiles'

const HREF = '/analytics/cashflow'

/**
 * Render cases for the dashboard widgets extracted from Cash Flow. WidgetCard
 * delegates every widget whose registry entry names this source here. Each
 * tile links to the Cash Flow dashboard and shows the position's own figure
 * for the org's configured horizon — never a re-derivation.
 */
export function CashWidgetCard({ widgetId, data }: WidgetCardProps): React.ReactNode {
  const t = useTranslations('dashboard')
  const { money } = useMoney()
  const { date } = useViewerFormat()
  // Noon-anchored like the dashboard tiles: a bare YYYY-MM-DD parses as UTC
  // midnight and would render a day early west of Greenwich.
  const fmtDay = (iso: string) => date(new Date(`${iso}T12:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' })

  switch (widgetId) {
    case 'kpi-cash-lowest-point': {
      // Tone is status as well as text: a below-zero low reads rose before a
      // single word is parsed, a caution-horizon low reads amber.
      const lowest = data.cashLowest
      if (!lowest || !lowest.available) {
        return (
          <MetricTile
            icon={<TrendingDown size={15} />}
            label={t('widgets.cashLowestPoint')}
            value="—"
            href={HREF}
            tone="slate"
            hint={lowest?.available === false ? lowest.reason : t('analytics.loading')}
          />
        )
      }
      const tone = lowest.value.status === 'critical' ? 'rose' : lowest.value.status === 'caution' ? 'amber' : 'emerald'
      return (
        <MetricTile
          icon={<TrendingDown size={15} />}
          label={t('widgets.cashLowestPoint')}
          value={money(lowest.value.amount, { currency: data.baseCurrency })}
          href={HREF}
          tone={tone}
          hint={t('metricContext.weekOf', { date: fmtDay(lowest.value.week) })}
        />
      )
    }
    case 'kpi-cash-burn': {
      const burn = data.cashBurn
      if (!burn || !burn.available) {
        return (
          <MetricTile
            icon={<Flame size={15} />}
            label={t('widgets.cashBurn')}
            value="—"
            href={HREF}
            tone="slate"
            hint={burn?.available === false ? burn.reason : t('analytics.loading')}
          />
        )
      }
      return (
        <MetricTile
          icon={<Flame size={15} />}
          label={t('widgets.cashBurn')}
          value={money(burn.value.weeklyOutflow, { currency: data.baseCurrency })}
          href={HREF}
          tone="amber"
          hint={t('widgets.cashBurnNet', { net: money(burn.value.netChange, { currency: data.baseCurrency }) })}
        />
      )
    }
    case 'kpi-cash-coverage': {
      const coverage = data.cashCoverage
      if (!coverage || !coverage.available) {
        return (
          <MetricTile
            icon={<ShieldCheck size={15} />}
            label={t('widgets.cashCoverage')}
            value="—"
            href={HREF}
            tone="slate"
            hint={coverage?.available === false ? coverage.reason : t('analytics.loading')}
          />
        )
      }
      return (
        <MetricTile
          icon={<ShieldCheck size={15} />}
          label={t('widgets.cashCoverage')}
          value={`${formatExactRatio(coverage.value.ratio)}×`}
          href={HREF}
          tone={coverage.value.covered ? 'emerald' : 'amber'}
        />
      )
    }
    case 'kpi-cash-settlement-days': {
      // Each side names itself when its history is missing: a side with no
      // payment history renders nothing for that side and says which.
      const collect = data.cashCollectDays
      const pay = data.cashPayDays
      if (!collect || !pay || !collect.available || !pay.available) {
        const reason = [collect, pay]
          .filter((side) => side?.available === false)
          .map((side) => (side as { available: false; reason: string }).reason)
          .join(' · ')
        return (
          <MetricTile
            icon={<RefreshCw size={15} />}
            label={t('widgets.cashSettlementDays')}
            value="—"
            href={HREF}
            tone="slate"
            hint={reason || t('analytics.loading')}
          />
        )
      }
      const collectDays = collect.value
      const payDays = pay.value
      if (collectDays === null) {
        return payDays === null ? (
          <MetricTile
            icon={<RefreshCw size={15} />}
            label={t('widgets.cashSettlementDays')}
            value="—"
            href={HREF}
            tone="slate"
            hint={`${t('analytics.noCollectHistory')} · ${t('analytics.noPayHistory')}`}
          />
        ) : (
          <MetricTile
            icon={<RefreshCw size={15} />}
            label={t('widgets.cashSettlementDays')}
            value={t('widgets.cashSettlementDaysPayOnly', { pay: payDays })}
            href={HREF}
            tone="slate"
            hint={t('analytics.noCollectHistory')}
          />
        )
      }
      if (payDays === null) {
        return (
          <MetricTile
            icon={<RefreshCw size={15} />}
            label={t('widgets.cashSettlementDays')}
            value={t('widgets.cashSettlementDaysCollectOnly', { collect: collectDays })}
            href={HREF}
            tone="slate"
            hint={t('analytics.noPayHistory')}
          />
        )
      }
      return (
        <MetricTile
          icon={<RefreshCw size={15} />}
          label={t('widgets.cashSettlementDays')}
          value={t('widgets.cashSettlementDaysValue', { collect: collectDays, pay: payDays })}
          href={HREF}
          tone="teal"
        />
      )
    }
    default:
      return null
  }
}
