'use client'

import { useTranslations } from 'next-intl'
import { Scale, TimerReset, Zap } from 'lucide-react'
import { useMoney } from '@/components/money-provider'
import { useViewerFormat } from '@/lib/viewer-format'
import { MetricTile, type MetricTone, type WidgetCardProps } from './_widget-tiles'

/**
 * Render cases for the dashboard widgets extracted from Vendor Performance and Spend Velocity. WidgetCard
 * delegates every widget whose registry entry names this source here.
 */
export function VendorWidgetCard(props: WidgetCardProps): React.ReactNode {
  switch (props.widgetId) {
    case 'kpi-vendor-concentration':
      return <VendorConcentrationTile data={props.data} />
    case 'kpi-vendor-payment-performance':
      return <VendorPaymentTile data={props.data} />
    case 'kpi-spend-velocity':
      return <SpendVelocityTile data={props.data} />
    default:
      return null
  }
}

const BAND_TONE: Record<string, MetricTone> = {
  diversified: 'emerald',
  moderate: 'amber',
  highlyConcentrated: 'rose',
}

function VendorConcentrationTile({ data }: { data: WidgetCardProps['data'] }) {
  const t = useTranslations('dashboard')
  const { number } = useViewerFormat()
  const hhi = data.concentrationHhi
  const share = data.concentrationTop5Share
  const period = data.vendorPeriodLabel
  if (!hhi.available || !share.available) {
    const reason = !hhi.available ? hhi.reason : share.available === false ? share.reason : ''
    return (
      <MetricTile
        icon={<Scale size={15} />}
        label={t('widgets.kpiVendorConcentration')}
        value="—"
        href="/analytics/vendor-performance"
        tone="slate"
        hint={reason}
      />
    )
  }
  return (
    <MetricTile
      icon={<Scale size={15} />}
      label={t('widgets.kpiVendorConcentration')}
      value={number(hhi.value, { maximumFractionDigits: 0 })}
      href="/analytics/vendor-performance"
      tone={BAND_TONE[data.concentrationBand ?? ''] ?? 'slate'}
      hint={t('widgets.kpiVendorConcentrationHint', {
        share: `${Math.round(share.value * 100)}%`,
        period: period ?? '',
      })}
    />
  )
}

function VendorPaymentTile({ data }: { data: WidgetCardProps['data'] }) {
  const t = useTranslations('dashboard')
  const ta = useTranslations('analytics')
  const { money } = useMoney()
  const rate = data.vendorOnTimeRate
  const days = data.vendorAvgDaysToPay
  const late = data.vendorLateSpend
  const period = data.vendorPeriodLabel
  if (!rate.available) {
    return (
      <MetricTile
        icon={<TimerReset size={15} />}
        label={t('widgets.kpiVendorPayment')}
        value={ta('vendor.labels.unrated')}
        href="/analytics/vendor-performance"
        tone="slate"
        hint={rate.reason}
      />
    )
  }
  const daysText = days.available ? Math.round(days.value) : null
  return (
    <MetricTile
      icon={<TimerReset size={15} />}
      label={t('widgets.kpiVendorPayment')}
      value={`${Math.round(rate.value * 100)}%`}
      href="/analytics/vendor-performance"
      tone="emerald"
      hint={t('widgets.kpiVendorPaymentHint', {
        days: daysText ?? '—',
        late: late.available ? money(late.value) : '—',
        period: period ?? '',
      })}
    />
  )
}

function SpendVelocityTile({ data }: { data: WidgetCardProps['data'] }) {
  const t = useTranslations('dashboard')
  const { money } = useMoney()
  const alerts = data.spendOpenAlerts
  const savings = data.spendSavingsPotential
  const period = data.vendorPeriodLabel
  if (!alerts.available) {
    return (
      <MetricTile
        icon={<Zap size={15} />}
        label={t('widgets.kpiSpendVelocity')}
        value="—"
        href="/analytics/spend-velocity"
        tone="slate"
        hint={alerts.reason}
      />
    )
  }
  return (
    <MetricTile
      icon={<Zap size={15} />}
      label={t('widgets.kpiSpendVelocity')}
      value={String(alerts.value)}
      href="/analytics/spend-velocity"
      tone={alerts.value > 0 ? 'amber' : 'emerald'}
      hint={
        savings.available
          ? t('widgets.kpiSpendVelocityHint', { savings: money(savings.value), period: period ?? '' })
          : savings.reason
      }
    />
  )
}
