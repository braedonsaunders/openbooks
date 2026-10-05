import 'server-only'
import { getTranslations } from 'next-intl/server'
import { cmp } from '@openbooks/engine/money'
import type { DashboardWidgetContext, WidgetValue } from './_metrics-context'
import { vendorData } from '@/lib/analytics/vendor-data'
import { spendVelocityData } from '@/lib/analytics/spend-velocity-data'
import { concentrationBand, type ConcentrationBand } from '@/lib/analytics/vendor-concentration'
import { englishCatalogMessage, type CatalogMessageFn } from '@/lib/analytics/catalog-strings'

/**
 * Dashboard widget readers for supplier concentration, payment performance and spend velocity (Vendor Performance, Spend Velocity).
 * Each field is read only when a visible widget lists it in
 * WIDGET_METRIC_FIELDS (_metrics.ts): a denied or absent widget's reader
 * never runs.
 *
 * Every figure below comes straight from the Analytics dashboard's own
 * loader (`vendorData` / `spendVelocityData`) over the caller's subsidiary
 * scope and the period the dashboards open on, so a widget and its
 * dashboard can never disagree. Unavailable figures carry the translated
 * reason instead of a fabricated zero.
 */
export type VendorWidgetMetrics = {
  concentrationHhi: WidgetValue<number>
  concentrationTop5Share: WidgetValue<number>
  concentrationBand: ConcentrationBand | null
  vendorOnTimeRate: WidgetValue<number>
  /** The organization's own on-time good mark (percentage points). */
  vendorOnTimeGoodRate: number
  vendorAvgDaysToPay: WidgetValue<number>
  vendorLateSpend: WidgetValue<string>
  vendorUnratedCount: WidgetValue<number>
  spendOpenAlerts: WidgetValue<number>
  spendSavingsPotential: WidgetValue<string>
  vendorPeriodLabel: string | null
}

export const EMPTY_VENDOR_WIDGET_METRICS: VendorWidgetMetrics = {
  concentrationHhi: { available: false, reason: '' },
  concentrationTop5Share: { available: false, reason: '' },
  concentrationBand: null,
  vendorOnTimeRate: { available: false, reason: '' },
  vendorOnTimeGoodRate: 0,
  vendorAvgDaysToPay: { available: false, reason: '' },
  vendorLateSpend: { available: false, reason: '' },
  vendorUnratedCount: { available: false, reason: '' },
  spendOpenAlerts: { available: false, reason: '' },
  spendSavingsPotential: { available: false, reason: '' },
  vendorPeriodLabel: null,
}

const unavailable = (reason: string): { available: false; reason: string } => ({ available: false, reason })

/**
 * Request-locale refusal reasons from the analytics catalog. Inside a
 * dashboard request they render in the operator's language; outside one
 * (tests, scripts) there is no request scope, so reasons fall back to the
 * English catalog rather than throwing.
 */
async function analyticsReason(): Promise<CatalogMessageFn> {
  try {
    const t = await getTranslations('analytics')
    return (key, values) => t(key, values as Record<string, string | number>)
  } catch {
    return englishCatalogMessage
  }
}

export async function loadVendorWidgetMetrics(
  ctx: DashboardWidgetContext,
  need: (...fields: (keyof VendorWidgetMetrics)[]) => boolean,
): Promise<Partial<VendorWidgetMetrics>> {
  const wantsVendor = need(
    'concentrationHhi',
    'concentrationTop5Share',
    'concentrationBand',
    'vendorOnTimeRate',
    'vendorOnTimeGoodRate',
    'vendorAvgDaysToPay',
    'vendorLateSpend',
    'vendorUnratedCount',
    'vendorPeriodLabel',
  )
  const wantsSpend = need('spendOpenAlerts', 'spendSavingsPotential')
  if (!wantsVendor && !wantsSpend) return {}
  const out: Partial<VendorWidgetMetrics> = {}
  const period = await ctx.period()
  const window = { from: period.from, to: period.to, label: period.label }
  if (wantsVendor) {
    // The dashboard's own loader: same scope, same window, same figures.
    const data = await vendorData(window, ctx.orgId, ctx.allowedSubsidiaryIds)
    out.vendorPeriodLabel = data.period.label
    // Concentration of nothing is not diversification: with no vendor spend
    // the tile stays unavailable by name instead of reading green.
    if (cmp(data.totals.spend, '0') <= 0) {
      const t = await analyticsReason()
      const noSpend = t('vendor.empty.noSpend')
      out.concentrationHhi = unavailable(noSpend)
      out.concentrationTop5Share = unavailable(noSpend)
      out.concentrationBand = null
    } else {
      out.concentrationHhi = { available: true, value: data.totals.hhiScaled }
      out.concentrationTop5Share = { available: true, value: data.totals.top5SharePct }
      out.concentrationBand = concentrationBand(
        data.totals.hhiScaled,
        data.config.hhiWarning,
        data.config.hhiCritical,
      )
    }
    if (need('vendorOnTimeRate', 'vendorOnTimeGoodRate', 'vendorAvgDaysToPay', 'vendorLateSpend', 'vendorUnratedCount')) {
      const t = await analyticsReason()
      const noHistory = t('vendor.payment.noHistory')
      out.vendorOnTimeGoodRate = data.config.onTimeGoodRate
      out.vendorOnTimeRate =
        data.totals.onTimePct === null ? unavailable(noHistory) : { available: true, value: data.totals.onTimePct }
      out.vendorAvgDaysToPay =
        data.totals.avgDaysToPay === null ? unavailable(noHistory) : { available: true, value: data.totals.avgDaysToPay }
      out.vendorLateSpend = { available: true, value: data.totals.lateSpend }
      out.vendorUnratedCount = {
        available: true,
        value: data.rows.filter((row) => row.quadrant === 'unrated').length,
      }
    }
  }
  if (wantsSpend) {
    // The dashboard's own loader: same scope, same window, same figures.
    const data = await spendVelocityData(ctx.orgId, window, ctx.allowedSubsidiaryIds)
    if (need('vendorPeriodLabel')) out.vendorPeriodLabel = data.period.label
    if (need('spendSavingsPotential')) {
      out.spendSavingsPotential = { available: true, value: data.summary.savingsPotential }
    }
    if (need('spendOpenAlerts')) {
      // The open-alert count depends on the full detector set: with the
      // fragmentation size cap unconfigured the count would silently exclude
      // a whole detector class, so it stays unavailable by name instead.
      if (data.fragmentation.summary.configured) {
        out.spendOpenAlerts = { available: true, value: data.summary.totalAlerts }
      } else {
        const t = await analyticsReason()
        out.spendOpenAlerts = unavailable(t('spendVelocity.insights.fragmentationUnconfigured'))
      }
    }
  }
  return out
}
