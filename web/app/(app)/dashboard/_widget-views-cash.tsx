'use client'

import { useTranslations } from 'next-intl'
import { TrendingDown } from 'lucide-react'
import { useMoney } from '@/components/money-provider'
import { useViewerFormat } from '@/lib/viewer-format'
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
    default:
      return null
  }
}
