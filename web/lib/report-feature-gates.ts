/**
 * Feature gates of report routes, as a registry (F1T-16).
 *
 * Each entry mirrors the gate its route enforces — `requireProjectsFeature`
 * from `lib/projects-gate`, or `requireFeatureEnabled` from
 * `lib/feature-gates` — so the hub's saved-views filter hides exactly the
 * views whose route would refuse the operator. Gating a new report route is
 * one entry here, not a hunt through the hub: the filter below reads this
 * registry, never a hand-maintained prefix list (which is how
 * `/reports/true-cost` kept showing with Projects off).
 *
 * Pure (no imports): safe for unit tests and both server and client bundles.
 */

export type GatedReportFeature = 'projects' | 'budgets' | 'orders' | 'inventory'

export const REPORT_PATH_FEATURE_GATES: ReadonlyArray<{
  prefix: string
  feature: GatedReportFeature
}> = [
  // lib/projects-gate requireProjectsFeature
  { prefix: '/reports/project-profitability', feature: 'projects' },
  { prefix: '/reports/true-cost', feature: 'projects' },
  // lib/feature-gates requireFeatureEnabled
  { prefix: '/reports/budget', feature: 'budgets' },
  { prefix: '/reports/orders', feature: 'orders' },
  { prefix: '/reports/lot-recall', feature: 'inventory' },
]

/**
 * A saved view stays on the hub only while every gate covering its path is
 * on. Matching is segment-boundary: `/reports/budget` covers the route and
 * any sub-path, but never a sibling like `/reports/budgetary`.
 */
export function savedReportPathVisible(
  path: string,
  enabled: Record<GatedReportFeature, boolean>,
): boolean {
  for (const { prefix, feature } of REPORT_PATH_FEATURE_GATES) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      if (!enabled[feature]) return false
    }
  }
  return true
}
