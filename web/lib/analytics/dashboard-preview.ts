import 'server-only'
import { withAuthzContext, requestAuthzContext } from '../authz-context'
import { getTranslations } from 'next-intl/server'
import { getMoneyFormatter } from '../money-server'
import { toChartNumber } from '../chart-number'
import { formatDecimal } from '../money-format'
import type { AnalyticsDashboardDefinition, AnalyticsPreview, AnalyticsPreviewChart } from './dashboard-catalog'
import { requirePermission, ForbiddenError } from '../authz'
import { analyticsDashboardAvailable } from './dashboard-access'
import { analyticsSourceQuery } from './query-params'
import { analyticsCacheIdentity, cachedAnalyticsPreview } from './preview-cache'
import { currentAnalyticsRead, withAnalyticsRead } from './read-context'

/** Reuse the dashboard loaders: previews never maintain their own financial calculations. */
export async function analyticsDashboardPreview(dashboard: AnalyticsDashboardDefinition, sp: Record<string, string | undefined>, orgId: string): Promise<AnalyticsPreview> {
  const authz = await requirePermission('reports.read')
  if (authz.user.orgId !== orgId || !await analyticsDashboardAvailable(authz, dashboard)) throw new ForbiddenError(dashboard.permission ?? dashboard.feature ?? 'reports.read')
  const query = analyticsSourceQuery(sp, dashboard.slug)
  return withAuthzContext(authz, async () => {
    const authority = requestAuthzContext()!
    const identity = await analyticsCacheIdentity(orgId)
    return withAnalyticsRead({ authz: authority, slug: dashboard.slug, tab: '', projection: 'summary', ...identity, observedAt: Date.now() }, () =>
      cachedAnalyticsPreview(authority, dashboard.slug, query, () => buildDashboardPreview(dashboard, query, orgId)))
  })
}

async function buildDashboardPreview(dashboard: AnalyticsDashboardDefinition, sp: Record<string, string | undefined>, orgId: string): Promise<AnalyticsPreview> {
  const t = await getTranslations('analytics')
  const fmt = await getMoneyFormatter(orgId)
  const number = (value: number | string | null | undefined) => value == null ? '—' : formatDecimal(fmt.locale, value, { maximumFractionDigits: 1 })
  // Loader KPIs arrive on the 0–100 scale; Intl renders the sign, spacing
  // and digits for the locale instead of a hardcoded `%` suffix.
  const percent = (value: number | null | undefined) => value == null
    ? '—'
    : new Intl.NumberFormat(fmt.locale, { style: 'percent', maximumFractionDigits: 1 }).format(value / 100)
  // Vendor shares arrive as fractions (0.85), not percent-scale numbers:
  // formatting the fraction as a percent reads 85%, not 0.9%.
  const share = (value: number | null | undefined) => value == null ? '—' : new Intl.NumberFormat(fmt.locale, { style: 'percent', maximumFractionDigits: 1 }).format(value)
  const metric = (key: string, value: string) => ({ label: t(key), value })
  let chart: AnalyticsPreviewChart | undefined
  // Trend points arrive as exact decimal strings from the loaders that
  // moved off floats: cross into chart numbers here, at the chart boundary.
  const trend = (label: string, points: (number | string)[], labels: string[]): AnalyticsPreviewChart | undefined => points.length > 1 ? { kind: 'sparkline', label, points: points.map((p) => typeof p === "number" ? p : toChartNumber(p)), from: labels[0]!, to: labels[labels.length - 1]! } : undefined
  const result = (periodLabel: string, metrics: AnalyticsPreview['metrics'], notice?: string): AnalyticsPreview => ({ ...(chart ? { chart } : {}), periodLabel, metrics, observedAt: new Date(currentAnalyticsRead()?.observedAt ?? Date.now()).toISOString(), ...(notice ? { notice } : {}) })
  switch (dashboard.slug) {
    case 'receivables-intelligence': {
      const { data, periodLabel } = await (await import('../../app/(app)/analytics/receivables-intelligence/view')).loadReceivablesIntelligence(sp)
      chart = { kind: 'donut', label: t('receivables.panels.aging'), slices: data.summary.aging.map((row) => ({ name: t(`receivables.aging.${row.index}`), value: toChartNumber(row.gross) })).filter((row) => row.value > 0) }
      return result(periodLabel, [metric('receivables.kpi.outstanding', fmt.money(data.summary.outstanding)), metric('receivables.kpi.overdue', fmt.money(data.summary.overdue)), metric('receivables.kpi.overdueShare', data.summary.overdueShare === null ? '—' : share(Number(data.summary.overdueShare))), metric('receivables.kpi.averageDays', number(data.summary.averageOverdueDays))])
    }
    case 'financial-health': {
      const { data, periodLabel } = await (await import('../../app/(app)/analytics/financial-health/view')).loadFinancialHealthPreview(sp)
      chart = trend(t('financialHealth.kpi.revenue'), data.monthly.map((month) => toChartNumber(month.revenue)), data.monthly.map((month) => month.label))
      const margin = data.ratios.profitability.find((ratio) => ratio.id === 'gross_margin')
      // Ratio values are already computed by the owning dashboard. Intl percent
      // formatting of the exact decimal string changes presentation only.
      const grossMargin = margin?.value == null ? '—' : new Intl.NumberFormat(fmt.locale, { style: 'percent', maximumFractionDigits: 1 }).format(margin.value as unknown as number)
      return result(periodLabel, [metric('financialHealth.kpi.revenue', fmt.money(data.figures.revenue)), metric('financialHealth.kpi.grossMargin', grossMargin), metric('financialHealth.kpi.operatingIncome', fmt.money(data.figures.operatingIncome)), metric('financialHealth.score.title', data.overallScore === null ? '—' : `${number(data.overallScore)}/100`)])
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
      // A broken weight sum refuses in the loader payload: surface it as the
      // hub notice instead of rendering empty figures as a healthy preview.
      if (data.weightsError) return result(periodLabel, [], data.weightsError)
      chart = trend(t('customer.kpi.periodRevenue'), data.growth.monthly.map((month) => toChartNumber(month.revenue)), data.growth.monthly.map((month) => month.label))
      return result(periodLabel, [metric('customer.kpi.totalCustomers', number(data.kpis.totalCustomers)), metric('customer.kpi.periodRevenue', fmt.money(data.kpis.totalRevenue)), metric('customer.kpi.totalInvoiced', fmt.money(data.kpis.totalInvoiced)), metric('customer.kpi.atRisk', number(data.kpis.atRiskCount))])
    }
    case 'vendor-performance': {
      const { data, periodLabel } = await (await import('../../app/(app)/analytics/vendor-performance/view')).loadVendorPerformance(sp)
      chart = trend(t('vendor.kpi.totalSpend'), data.monthly.map((month) => month.spend), data.monthly.map((month) => month.label))
      return result(periodLabel, [metric('vendor.kpi.activeVendors', number(data.totals.vendors)), metric('vendor.kpi.totalSpend', fmt.money(data.totals.spend)), metric('vendor.kpi.onTimeRate', share(data.totals.onTimePct)), metric('vendor.kpi.top5Share', share(data.totals.top5SharePct))])
    }
    case 'spend-velocity': {
      const { data, periodLabel } = await (await import('../../app/(app)/analytics/spend-velocity/view')).loadSpendVelocity(sp)
      chart = trend(t('spendVelocity.kpi.totalSpend'), data.monthlyTrends.map((month) => month.totalAmount), data.monthlyTrends.map((month) => month.month))
      return result(periodLabel, [metric('spendVelocity.kpi.totalSpend', fmt.money(data.summary.totalSpend)), metric('spendVelocity.kpi.avgVelocity', percent(data.summary.avgVelocity)), metric('spendVelocity.kpi.savingsPotential', data.summary.savingsPotential === null ? '—' : fmt.money(data.summary.savingsPotential)), metric('spendVelocity.kpi.alerts', number(data.summary.totalAlerts))])
    }
    case 'sentinel': {
      const { data, periodLabel } = await (await import('../../app/(app)/analytics/sentinel/view')).loadSentinel(sp)
      chart = { kind: 'gauge', label: t('hub.riskScore'), value: data.summary.overallRiskScore, goodWhenHigh: false }
      return result(periodLabel, [metric('sentinel.kpi.flagged', number(data.summary.flaggedCount)), metric('sentinel.kpi.duplicatePairs', number(data.summary.duplicateCount)), metric('sentinel.kpi.valueAtRisk', fmt.money(data.summary.totalAtRisk, { currency: data.meta.presentationCurrency })), metric('hub.riskScore', `${number(data.summary.overallRiskScore)}/100`)])
    }
  }
  // Unknown slugs are a caller bug, but the message still comes from the
  // catalog — no user-facing English lives in this module.
  throw new Error(t('preview.unavailable'))
}
