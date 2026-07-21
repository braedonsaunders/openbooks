import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'

/**
 * Optional-feature registry — the single source of truth for what an org can
 * switch on/off in Company Settings → Features. Not every company uses every
 * feature: a feature that's off disappears from nav, its routes 404, and its
 * setup surfaces hide — but its DATA is never touched by toggling.
 *
 * Keys are STABLE ids (org settings reference them). State lives in
 * `orgs.settings.features.{key}` (boolean); absence = the registry default.
 * Labels/descriptions are i18n (`admin.features.{key}.*`), never stored.
 */
export interface FeatureDef {
  key: string
  /** Enabled for orgs that have never touched the toggle. */
  defaultEnabled: boolean
  /** Nav module keys hidden while the feature is off. */
  navModules?: string[]
  /** Grouping on the Features page. */
  category: 'sales' | 'operations' | 'accounting' | 'platform'
}

/** The full switchboard (QBO "Enable features" / NetSuite Enable Features):
 * everything currently visible defaults ON so existing orgs see no change;
 * new optional modules (field tickets) default OFF. */
export const FEATURES: FeatureDef[] = [
  // Sales & customers
  { key: 'crm', defaultEnabled: true, category: 'sales', navModules: ['crm-leads', 'crm-prospects', 'crm-opportunities', 'crm-activities', 'crm-forecasts'] },
  { key: 'orders', defaultEnabled: true, category: 'sales', navModules: ['estimates', 'sales-orders', 'purchase-orders'] },
  { key: 'revenueRecognition', defaultEnabled: true, category: 'sales', navModules: ['revenue'] },
  // Operations
  { key: 'projects', defaultEnabled: true, category: 'operations', navModules: ['projects'] },
  { key: 'timeTracking', defaultEnabled: true, category: 'operations', navModules: ['timesheets'] },
  { key: 'fieldTickets', defaultEnabled: false, category: 'operations', navModules: ['field-tickets'] },
  { key: 'inventory', defaultEnabled: true, category: 'operations', navModules: ['inventory'] },
  { key: 'equipment', defaultEnabled: true, category: 'operations', navModules: ['equipment'] },
  { key: 'expenses', defaultEnabled: true, category: 'operations', navModules: ['expenses'] },
  // Accounting
  { key: 'banking', defaultEnabled: true, category: 'accounting', navModules: ['banking-cash', 'banking-transactions', 'banking-match', 'banking-recons', 'banking-rules', 'banking-imports'] },
  { key: 'fixedAssets', defaultEnabled: true, category: 'accounting', navModules: ['assets', 'tax-depreciation'] },
  { key: 'budgets', defaultEnabled: true, category: 'accounting', navModules: ['budgets'] },
  { key: 'continuousClose', defaultEnabled: true, category: 'accounting', navModules: ['continuous-close'] },
  // Platform
  { key: 'flows', defaultEnabled: true, category: 'platform', navModules: ['flows'] },
  { key: 'apps', defaultEnabled: true, category: 'platform', navModules: ['apps', 'admin-apps'] },
]

export const FEATURE_BY_KEY = new Map(FEATURES.map((f) => [f.key, f]))

export type FeatureState = Record<string, boolean>

/** Pure: resolve one feature from a settings.features object. */
export function featureEnabled(state: FeatureState | null | undefined, key: string): boolean {
  const def = FEATURE_BY_KEY.get(key)
  if (!def) return false
  const v = state?.[key]
  return typeof v === 'boolean' ? v : def.defaultEnabled
}

/** Load the org's feature state (raw overrides; combine with featureEnabled). */
export async function orgFeatureState(orgId: string): Promise<FeatureState> {
  const r = (await db.execute(sql`select settings->'features' as f from orgs where id = ${orgId}`)) as unknown as {
    rows: { f: FeatureState | null }[]
  }
  return r.rows[0]?.f ?? {}
}

/** Server helper for route guards: is this feature on for the org? */
export async function isFeatureEnabled(orgId: string, key: string): Promise<boolean> {
  return featureEnabled(await orgFeatureState(orgId), key)
}

/** The set of nav module keys hidden by disabled features (for the resolver). */
export function hiddenNavModules(state: FeatureState): Set<string> {
  const hidden = new Set<string>()
  for (const f of FEATURES) {
    if (!featureEnabled(state, f.key)) for (const m of f.navModules ?? []) hidden.add(m)
  }
  return hidden
}
