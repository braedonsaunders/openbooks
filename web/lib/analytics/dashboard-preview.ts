import 'server-only'
import { getTranslations } from 'next-intl/server'
import { getMoneyFormatter } from '../money-server'
import { toChartNumber } from '../chart-number'
import { formatDecimal } from '../money-format'
import type { AnalyticsDashboardDefinition, AnalyticsPreview, AnalyticsPreviewChart } from './dashboard-catalog'

/** Reuse the dashboard loaders: previews never maintain their own financial calculations. */
export async function analyticsDashboardPreview(dashboard: AnalyticsDashboardDefinition, sp: Record<string, string | undefined>, orgId: string): Promise<AnalyticsPreview> {
  const t = await getTranslations('analytics')
  const fmt = await getMoneyFormatter(orgId)
  const number = (value: number | string | null | undefined) => value == null ? '—' : formatDecimal(fmt.locale, value, { maximumFractionDigits: 1 })
  const percent = (value: number | null | undefined) => value == null ? '—' : `${number(value)}%`
  const metric = (key: string, value: string) => ({ label: t(key), value })
  let chart: AnalyticsPreviewChart | undefined
  const trend = (label: string, points: number[], labels: string[]): AnalyticsPreviewChart | undefined => points.length > 1 ? { kind: 'sparkline', label, points, from: labels[0]!, to: labels[labels.length - 1]! } : undefined
  const result = (periodLabel: string, metrics: AnalyticsPreview['metrics'], notice?: string): AnalyticsPreview => ({ ...(chart ? { chart } : {}), periodLabel, metrics, observedAt: new Date().toISOString(), ...(notice ? { notice } : {}) })
  switch (dashboard.slug) {
    case 'financial-health': {
      const { data, periodLabel } = await (await import('../../app/(app)/analytics/financial-health/view')).loadFinancialHealthPreview(sp)
      chart = trend(t('financialHealth.kpi.revenue'), data.monthly.map((month) => toChartNumber(month.revenue)), data.monthly.map((month) => month.label))
      const margin = data.ratios.profitability.find((ratio) => ratio.id === 'gross_margin')
      // Ratio values are already computed by the owning dashboard. Intl percent
      // formatting changes presentation only; it does not recompute the ratio.
      const grossMargin = margin?.value == null ? '—' : new Intl.NumberFormat(fmt.locale, { style: 'percent', maximumFractionDigits: 1 }).format(margin.value)
      return result(periodLabel, [metric('financialHealth.kpi.revenue', fmt.money(data.figures.revenue)), metric('financialHealth.kpi.grossMargin', grossMargin), metric('financialHealth.kpi.operatingIncome', fmt.money(data.figures.operatingIncome)), metric('financialHealth.score.title', `${number(data.overallScore)}/100`)])
    }
    case 'cashflow': {
      const { data, periodLabel, horizon } = await (await import('../../app/(app)/analytics/cashflow/view')).loadCashflow(sp)
      chart = trend(t('cashflow.kpi.projectedEnd'), [toChartNumber(data.summary.startingCash), ...data.weeks.map((week) => toChartNumber(week.endingCash))], [data.asOf, ...data.weeks.map((week) => week.label)])
      return result(`${periodLabel} · ${t('hub.forecastWeeks', { weeks: horizon })}`, [metric('cashflow.kpi.currentCash', fmt.money(data.summary.startingCash)), metric('cashflow.kpi.projectedEnd', fmt.money(data.summary.projectedEnd)), metric('cashflow.kpi.inflows', fmt.money(data.summary.totalInflows)), metric('cashflow.kpi.outflows', fmt.money(data.summary.totalOutflows))])
    }
    case 'true-cost': {
      const { data, periodLabel, refusal } = await (await import('../../app/(app)/analytics/true-cost/view')).loadTrueCost(sp)
      if (!data) return result(periodLabel, [], refusal ?? t('hub.loadError'))
      chart = trend(t('trueCost.hero.totalOverhead'), data.monthly.map((month) => toChartNumber(month.burden)), data.monthly.map((month) => month.label))
      return result(periodLabel, [metric('trueCost.hero.totalOverhead', fmt.money(data.kpis.totalOverhead)), metric('trueCost.hero.overheadApplied', fmt.money(data.kpis.burdenApplied)), metric('trueCost.hero.absorption', percent(data.kpis.absorptionPct)), metric('trueCost.hero.billedHours', number(data.kpis.billedHours))])
    }
    case 'utilization': {
      const { data, periodLabel } = await (await import('../../app/(app)/analytics/utilization/view')).loadUtilization(sp)
      chart = trend(t('hub.utilizationRate'), data.history.periods.map((period) => period.companyPct), data.history.periods.map((period) => period.label))
      const range = data.company.range
      return result(periodLabel, [metric('utilization.kpi.totalHours', number(range.hours)), metric('utilization.kpi.billableHours', number(range.billableHours)), metric('hub.utilizationRate', percent(range.percentBilled)), metric('utilization.kpi.nonBillableCost', fmt.money(range.nonBillableCost))])
    }
    case 'customer-intelligence': {
      const { data, periodLabel } = await (await import('../../app/(app)/analytics/customer-intelligence/view')).loadCustomerIntelligencePreview(sp)
      chart = trend(t('customer.kpi.periodRevenue'), data.growth.monthly.map((month) => month.revenue), data.growth.monthly.map((month) => month.label))
      return result(periodLabel, [metric('customer.kpi.totalCustomers', number(data.kpis.totalCustomers)), metric('customer.kpi.periodRevenue', fmt.money(data.kpis.totalRevenue)), metric('customer.kpi.totalInvoiced', fmt.money(data.kpis.totalInvoiced)), metric('customer.kpi.atRisk', number(data.kpis.atRiskCount))])
    }
    case 'vendor-performance': {
      const { data, periodLabel } = await (await import('../../app/(app)/analytics/vendor-performance/view')).loadVendorPerformance(sp)
      chart = trend(t('vendor.kpi.totalSpend'), data.monthly.map((month) => month.spend), data.monthly.map((month) => month.label))
      return result(periodLabel, [metric('vendor.kpi.activeVendors', number(data.totals.vendors)), metric('vendor.kpi.totalSpend', fmt.money(data.totals.spend)), metric('vendor.kpi.onTimeRate', percent(data.totals.onTimePct)), metric('vendor.kpi.top5Share', percent(data.totals.top5SharePct))])
    }
    case 'spend-velocity': {
      const { data, periodLabel } = await (await import('../../app/(app)/analytics/spend-velocity/view')).loadSpendVelocity(sp)
      chart = trend(t('spendVelocity.kpi.totalSpend'), data.monthlyTrends.map((month) => month.totalAmount), data.monthlyTrends.map((month) => month.month))
      return result(periodLabel, [metric('spendVelocity.kpi.totalSpend', fmt.money(data.summary.totalSpend)), metric('spendVelocity.kpi.avgVelocity', percent(data.summary.avgVelocity)), metric('spendVelocity.kpi.savingsPotential', fmt.money(data.summary.savingsPotential)), metric('spendVelocity.kpi.alerts', number(data.summary.totalAlerts))])
    }
    case 'sentinel': {
      const { data, periodLabel } = await (await import('../../app/(app)/analytics/sentinel/view')).loadSentinel(sp)
      chart = { kind: 'gauge', label: t('hub.riskScore'), value: data.summary.overallRiskScore, goodWhenHigh: false }
      return result(periodLabel, [metric('sentinel.kpi.flagged', number(data.summary.flaggedCount)), metric('sentinel.kpi.duplicatePairs', number(data.summary.duplicateCount)), metric('sentinel.kpi.valueAtRisk', fmt.money(data.summary.totalAtRisk, { currency: data.meta.presentationCurrency })), metric('hub.riskScore', `${number(data.summary.overallRiskScore)}/100`)])
    }
  }
  throw new Error('Analytics dashboard preview is unavailable')
}
