import 'server-only'
import type { Authz } from '@/lib/authz'
import { isFeatureEnabled } from '@/lib/features'
import { canSeeWidget } from './_widget-access'
import { WIDGETS } from './_widget-registry'
import { ANALYTICS_DASHBOARD_MAP } from '@/lib/analytics/dashboard-catalog'

/**
 * The one map from dashboard widget id to the feature key that gates it.
 *
 * The dashboard used to check these features ad hoc in two places:
 * default-layout composition (`_load-layout.ts`, which fetches the payroll,
 * HR and announcements flags) and persona metrics (`_persona.ts`, which
 * gates each gated reader inline). Both call sites read this map now, so a
 * key changes in exactly one place. A null key means the widget carries no
 * feature gate and resolves on permission alone.
 *
 * Absent deliberately: `home-upcoming` joins on either of two features,
 * `team-quals` rides a source probe rather than a feature, and the admin
 * rail gates on grants — none of them has a single feature key.
 */
const WIDGET_FEATURES: Record<string, string> = {
  'pay-tile': 'payroll',
  'balance-tile': 'hrm',
  'celebrations-list': 'hrm',
  'announcements-card': 'homeAnnouncements',
  'team-headcount': 'hrm',
  'team-nudges': 'hrm',
  'resourcing-pulse': 'resourcing',
  'budget-variance': 'budgets',
}

export function widgetFeatureKey(widgetId: string): string | null {
  const own = WIDGET_FEATURES[widgetId]
  if (own) return own
  // A widget extracted from an Analytics dashboard carries that dashboard's
  // Company Features gate (Projects for True Cost, Time Tracking for
  // Utilization) — declared once, in the analytics catalog.
  const source = WIDGETS[widgetId]?.analyticsSource
  return (source && ANALYTICS_DASHBOARD_MAP[source]?.feature) || null
}

/** True when the widget's feature gate (if any) resolves on for the org. */
export async function widgetFeatureOn(orgId: string, widgetId: string): Promise<boolean> {
  const key = widgetFeatureKey(widgetId)
  if (key === null) return true
  return isFeatureEnabled(orgId, key)
}

/**
 * The one feature-aware allowed-widget-id resolver for the dashboard.
 *
 * A registry id is allowed only when the caller may see it (the synchronous
 * permission/persona/insight/app decision in canSeeWidget, unchanged) AND
 * its feature gate from the single map above resolves on for the org. Every
 * server boundary — view slot, edit slot, edit/view canvas, save filter —
 * derives its registry ids from this set, so a tile the org switched off
 * can never be rendered, offered, or persisted, whatever the caller's
 * grants. Insight-card UUIDs and app tiles carry no single feature key and
 * keep resolving through canSeeWidget at each call site.
 *
 * The feature check defaults to the live gate; tests pass a stub for that
 * database-backed flag while permission checks stay real.
 */
/** Registry ids the caller may use, resolved once per server entry boundary. */
export type AllowedWidgetIds = ReadonlySet<string>

export async function resolveAllowedWidgetIds(
  authz: Authz,
  featureOn: (widgetId: string) => Promise<boolean> = (widgetId) =>
    widgetFeatureOn(authz.user.orgId, widgetId),
): Promise<AllowedWidgetIds> {
  const visible = Object.keys(WIDGETS).filter((id) => canSeeWidget(authz, id))
  const gated = visible.filter((id) => widgetFeatureKey(id) !== null)
  const states = await Promise.all(gated.map((id) => featureOn(id)))
  const off = new Set(gated.filter((_, index) => !states[index]))
  if (off.size === 0) return new Set(visible)
  return new Set(visible.filter((id) => !off.has(id)))
}
