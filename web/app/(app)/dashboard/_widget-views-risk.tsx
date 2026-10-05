'use client'

import { useTranslations } from 'next-intl'
import { RISK_SCORE_BANDS } from '@/lib/analytics/sentinel-scoring'
import { Copy, ShieldAlert } from 'lucide-react'
import { useMoney } from '@/components/money-provider'
import { CardShell, MetricTile, UnavailableRow, type MetricTone, type WidgetCardProps } from './_widget-tiles'

/**
 * Render cases for the dashboard widgets extracted from Sentinel. WidgetCard
 * delegates every widget whose registry entry names this source here.
 *
 * Both tiles show the dashboard's own figures through the shared summary —
 * never re-derived — and link to the dashboard. The risk tone reads the
 * shared severity-model bands, so the tile and the Sentinel gauge agree on
 * what a score means.
 */
function scoreTone(score: number): MetricTone {
  if (score >= RISK_SCORE_BANDS.high) return 'rose'
  if (score >= RISK_SCORE_BANDS.elevated) return 'orange'
  if (score >= RISK_SCORE_BANDS.moderate) return 'amber'
  return 'emerald'
}

export function RiskWidgetCard({ widgetId, data }: WidgetCardProps): React.ReactNode {
  const t = useTranslations('dashboard')
  const { money } = useMoney()
  switch (widgetId) {
    case 'kpi-forensic-risk': {
      const tile = data.forensicRisk
      if (tile === null) return null
      return (
        <MetricTile
          icon={<ShieldAlert size={15} />}
          label={t('widgets.forensicRisk')}
          value={String(tile.score)}
          href="/analytics/sentinel"
          tone={scoreTone(tile.score)}
          hint={t('widgets.forensicRiskHint', {
            flagged: tile.flagged,
            value: money(tile.value, { currency: tile.currency }),
            period: tile.periodLabel,
          })}
        />
      )
    }
    case 'kpi-duplicate-payments': {
      const tile = data.duplicatePayments
      if (tile === null) return null
      if (!tile.available) {
        return (
          <CardShell title={t('widgets.duplicatePayments')} icon={<Copy size={15} />} href="/analytics/sentinel">
            <UnavailableRow reason={tile.reason} />
          </CardShell>
        )
      }
      const dup = tile.value
      return (
        <MetricTile
          icon={<Copy size={15} />}
          label={t('widgets.duplicatePayments')}
          value={String(dup.groups)}
          href="/analytics/sentinel"
          tone={dup.groups > 0 ? 'amber' : 'emerald'}
          hint={t('widgets.duplicatePaymentsHint', {
            value: money(dup.value, { currency: dup.currency }),
            period: dup.periodLabel,
          })}
        />
      )
    }
    default:
      return null
  }
}
