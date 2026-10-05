import 'server-only'
import { getLocale, getTranslations } from 'next-intl/server'
import { isFeatureEnabled } from '@/lib/features'
import { utilizationData } from '@/lib/analytics/utilization-data'
import { utilizationStrings } from '@/lib/analytics/utilization-strings'
import { trueCostData } from '@/lib/analytics/true-cost-data'
import { trueCostStrings } from '@/lib/analytics/true-cost-strings'
import { presentationCurrency } from '@/lib/fx-presentation'
import type { RateFormat } from '@/lib/analytics/true-cost-engine'
import type { DashboardWidgetContext, WidgetValue } from './_metrics-context'

/**
 * Dashboard widget readers for utilization and overhead absorption (Utilization, True Cost).
 * One loader run per request feeds the tile, so a tile and its dashboard can
 * never disagree. Each field is read only when a visible widget lists it in
 * WIDGET_METRIC_FIELDS (_metrics.ts): a denied or absent widget's reader
 * never runs. A refusal (no cost basis, mixed units, missing schedule hours)
 * surfaces on the tile with its message instead of a zero.
 */
export type UtilizationWidgetSummary = {
  periodLabel: string
  companyPct: number
  target: number
  anomalyCount: number
  /** Employees whose overtime state is unknown (no resolving schedule). */
  unscheduled: number
}

export type TrueCostWidgetSummary = {
  periodLabel: string
  compositeRate: number | null
  compositeFormat: RateFormat | null
  /** The composite refusal message when the headline rate refuses. */
  refusal: string | null
  absorptionPct: number | null
  /** Applied minus burden (negative = under-absorbed); null when unavailable. */
  gap: number | null
  /** Why absorption is unavailable, when the loader says so. */
  absorptionNote: string | null
}

export type ProjectWidgetMetrics = {
  utilizationSummary: WidgetValue<UtilizationWidgetSummary> | null
  trueCostSummary: WidgetValue<TrueCostWidgetSummary> | null
}

export const EMPTY_PROJECT_WIDGET_METRICS: ProjectWidgetMetrics = {
  utilizationSummary: null,
  trueCostSummary: null,
}

/** Server-side anomaly count using the dashboard's own configured cutoffs. */
function countUtilizationAnomalies(data: Awaited<ReturnType<typeof utilizationData>>): number {
  const noBill = new Set(data.departments.filter((d) => d.noBillable).map((d) => d.id))
  const employees = data.employees.filter((e) => !e.departmentId || !noBill.has(e.departmentId))
  const cfg = data.config
  let drops = 0
  let overtime = 0
  for (const e of employees) {
    if (e.range.hours >= cfg.minHours && e.deltas.pctDelta < -cfg.anomalyDropPp) drops += 1
    if (e.overtimeVsSchedule === true && e.range.percentBilled < cfg.target - cfg.overtimeBillableGapPp) overtime += 1
  }
  const byTitle = new Map<string, number[]>()
  for (const e of employees) {
    if (e.range.hours < cfg.minHours) continue
    const list = byTitle.get(e.title ?? '') ?? []
    list.push(e.deltas.pctDelta)
    byTitle.set(e.title ?? '', list)
  }
  let drift = 0
  for (const deltas of byTitle.values()) {
    if (deltas.length < cfg.peerMinCount) continue
    const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length
    if (avg < -cfg.titleDriftPp && deltas.every((d) => d < 0)) drift += 1
  }
  return drops + overtime + drift
}

export async function loadProjectWidgetMetrics(
  ctx: DashboardWidgetContext,
  need: (...fields: (keyof ProjectWidgetMetrics)[]) => boolean,
): Promise<Partial<ProjectWidgetMetrics>> {
  const wantUtilization = need('utilizationSummary')
  const wantTrueCost = need('trueCostSummary')
  if (!wantUtilization && !wantTrueCost) return {}
  const period = await ctx.period()
  const out: Partial<ProjectWidgetMetrics> = {}

  const [utilization, trueCost] = await Promise.all([
    wantUtilization
      ? (async () => {
          if (!(await isFeatureEnabled(ctx.orgId, 'timeTracking'))) return null
          const [t, locale] = await Promise.all([getTranslations('analytics'), getLocale()])
          const strings = utilizationStrings((key, values) => t(key, values), locale)
          return utilizationData(ctx.orgId, period, ctx.allowedSubsidiaryIds, strings)
        })().then((data) => ({ ok: true as const, data }), (error: unknown) => ({ ok: false as const, error }))
      : null,
    wantTrueCost
      ? (async () => {
          if (!(await isFeatureEnabled(ctx.orgId, 'projects'))) return null
          const [t, locale, currency] = await Promise.all([getTranslations('analytics'), getLocale(), presentationCurrency(ctx.orgId)])
          const strings = trueCostStrings((key, values) => t(key, values), locale, currency)
          return trueCostData(ctx.orgId, period, ctx.allowedSubsidiaryIds, strings)
        })().then((data) => ({ ok: true as const, data }), (error: unknown) => ({ ok: false as const, error }))
      : null,
  ])

  if (utilization) {
    if (!utilization.ok) out.utilizationSummary = { available: false, reason: utilization.error instanceof Error ? utilization.error.message : 'Unavailable' }
    else if (utilization.data === null) out.utilizationSummary = null
    else {
      const u = utilization.data
      out.utilizationSummary = {
        available: true,
        value: {
          periodLabel: period.label,
          companyPct: u.company.range.percentBilled,
          target: u.config.target,
          anomalyCount: countUtilizationAnomalies(u),
          unscheduled: u.overtimeUnscheduled,
        },
      }
    }
  }

  if (trueCost) {
    if (!trueCost.ok) out.trueCostSummary = { available: false, reason: trueCost.error instanceof Error ? trueCost.error.message : 'Unavailable' }
    else if (trueCost.data === null) out.trueCostSummary = null
    else {
      const k = trueCost.data.kpis
      out.trueCostSummary = {
        available: true,
        value: {
          periodLabel: period.label,
          compositeRate: k.compositeRate,
          compositeFormat: k.compositeFormat,
          refusal: k.compositeRate === null ? (trueCost.data.compositeRefusal?.message ?? null) : null,
          absorptionPct: k.absorptionPct,
          gap: k.gap,
          absorptionNote: trueCost.data.absorptionUnavailable,
        },
      }
    }
  }
  return out
}
