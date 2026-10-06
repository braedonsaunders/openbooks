'use client'

import { useCallback, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { AreaChart, Flame, RefreshCw, ShieldCheck, TrendingDown } from 'lucide-react'
import { useMoney } from '@/components/money-provider'
import { useViewerFormat } from '@/lib/viewer-format'
import { Chart, cashForecastOption } from '../analytics/_ui/charts'
import { formatExactRatio } from '../analytics/_ui/format'
import { ChartTile, MetricTile, UnavailableRow, type WidgetCardProps } from './_widget-tiles'
import type { CashForecast } from './_metrics-cash'

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
  // A partial forecast names its refused categories on the hint — the figure
  // above understates outflows, so it never stands alone as a healthy fact.
  const refusedSuffix = (refused: string[]): string =>
    refused.length > 0 ? ` · ${t('metricContext.excludesCategories', { names: refused.join(', ') })}` : ''

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
          value={money(lowest.value.amount, { currency: data.baseCurrency ?? undefined })}
          href={HREF}
          tone={tone}
          hint={`${t('metricContext.weekOf', { date: fmtDay(lowest.value.week) })}${refusedSuffix(lowest.value.refused)}`}
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
          value={money(burn.value.weeklyOutflow, { currency: data.baseCurrency ?? undefined })}
          href={HREF}
          tone="amber"
          hint={`${t('widgets.cashBurnNet', { net: money(burn.value.netChange, { currency: data.baseCurrency ?? undefined }) })}${refusedSuffix(burn.value.refused)}`}
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
    case 'chart-cash-forecast': {
      const forecast = data.cashForecast
      if (!forecast || !forecast.available) {
        return (
          <ChartTile
            title={t('widgets.cashForecast')}
            icon={<AreaChart size={14} />}
            href={HREF}
          >
            <UnavailableRow reason={forecast?.available === false ? forecast.reason : t('analytics.loading')} />
          </ChartTile>
        )
      }
      return (
        <ForecastChart
          forecast={forecast.value}
          currency={data.baseCurrency ?? undefined}
          title={t('widgets.cashForecast')}
        />
      )
    }
    default:
      return null
  }
}

/**
 * Weekly projected ending cash over the horizon — the Cash Flow dashboard's
 * own forecast chart (same option builder, same rows) inside a chart tile.
 * The headline is the projected end; the context names the horizon.
 */
function ForecastChart({ forecast, currency, title }: { forecast: CashForecast; currency: string | undefined; title: string }) {
  const t = useTranslations('dashboard')
  const tCharts = useTranslations('analytics.charts')
  const { money } = useMoney()
  const label = useCallback((value: string | number) => money(value, { currency }), [money, currency])
  const labels = useMemo(
    () => ({
      endingCash: tCharts('weekly.endingCash'),
      lowest: tCharts('weekly.lowest'),
      in: tCharts('weekly.in'),
      out: tCharts('weekly.out'),
      net: tCharts('weekly.net'),
      ending: tCharts('weekly.ending'),
    }),
    [tCharts],
  )
  const option = useMemo(() => cashForecastOption(forecast.weeks, label, labels), [forecast, label, labels])
  return (
    <ChartTile
      title={title}
      icon={<AreaChart size={14} />}
      href={HREF}
      headline={money(forecast.projectedEnd, { currency })}
      context={`${t('widgets.cashForecastContext', { weeks: forecast.horizonWeeks })}${forecast.refused.length > 0 ? ` · ${t('metricContext.excludesCategories', { names: forecast.refused.join(', ') })}` : ''}`}
    >
      <Chart option={option} height="fill" />
    </ChartTile>
  )
}
