import 'server-only'
import { isFeatureEnabled } from '@/lib/features'

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
}

export function widgetFeatureKey(widgetId: string): string | null {
  return WIDGET_FEATURES[widgetId] ?? null
}

/** True when the widget's feature gate (if any) resolves on for the org. */
export async function widgetFeatureOn(orgId: string, widgetId: string): Promise<boolean> {
  const key = widgetFeatureKey(widgetId)
  if (key === null) return true
  return isFeatureEnabled(orgId, key)
}
