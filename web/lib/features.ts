import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
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
  /** False when the authoritative switch lives on a module-specific Company
   *  Settings page rather than the generic Features switchboard. */
  showInSwitchboard?: boolean
  /** Optional authoritative parent module. A child can never resolve enabled
   *  while its parent is disabled, regardless of stale stored overrides. */
  parentKey?: string
}

/** The full feature switchboard:
 * everything currently visible defaults ON so existing orgs see no change;
 * new optional modules (field tickets) default OFF. */
export const FEATURES: FeatureDef[] = [
  // Sales & customers
  { key: 'crm', defaultEnabled: true, category: 'sales', navModules: ['crm-leads', 'crm-prospects', 'crm-opportunities', 'crm-activities', 'crm-forecasts'] },
  { key: 'orders', defaultEnabled: true, category: 'sales', navModules: ['estimates', 'sales-orders', 'purchase-orders'] },
  { key: 'revenueRecognition', defaultEnabled: true, category: 'sales', navModules: ['revenue'] },
  // Subscription billing: plans + subscriptions that auto-generate recurring
  // invoices (SaaS/retainer style). Off by default — recurring document
  // schedules + dunning work without it; this adds the plan/subscription model.
  { key: 'subscriptionBilling', defaultEnabled: false, category: 'sales' },
  // Operations
  // Projects is governed from Company Settings → Projects. Schedule-of-values
  // billing is a project-type billing procedure, not an independent module.
  { key: 'projects', defaultEnabled: true, category: 'operations', navModules: ['projects', 'construction-billing', 'field-tickets'], showInSwitchboard: false },
  { key: 'timeTracking', defaultEnabled: true, category: 'operations', navModules: ['timesheets'] },
  { key: 'fieldTickets', defaultEnabled: false, category: 'operations', navModules: ['field-tickets'], showInSwitchboard: false, parentKey: 'projects' },
  { key: 'inventory', defaultEnabled: true, category: 'operations', navModules: ['inventory'] },
  { key: 'equipment', defaultEnabled: true, category: 'operations', navModules: ['equipment'] },
  { key: 'expenses', defaultEnabled: true, category: 'operations', navModules: ['expenses'] },
  // Accounting
  // Multi-subsidiary: consolidation, intercompany, and per-entity
  // currencies/books. Data-dependent default — resolved by subsidiaryFeatureEnabled,
  // NOT the static defaultEnabled below (which only applies to brand-new orgs).
  { key: 'multiSubsidiary', defaultEnabled: false, category: 'accounting' },
  // Multi-currency: transact in currencies other than the base, with FX rates,
  // revaluation, and realized/unrealized gain-loss. Data-dependent default (see
  // resolveMultiCurrency), NOT the static flag below.
  { key: 'multiCurrency', defaultEnabled: false, category: 'accounting' },
  { key: 'banking', defaultEnabled: true, category: 'accounting', navModules: ['banking-cash', 'banking-transactions', 'banking-match', 'banking-recons', 'banking-rules', 'banking-imports'] },
  // Automated bank connectivity (SFTP file drops + Plaid/GoCardless/TrueLayer
  // live feeds). Off by default — manual OFX/CSV import always works without it.
  { key: 'bankFeeds', defaultEnabled: false, category: 'accounting' },
  { key: 'fixedAssets', defaultEnabled: true, category: 'accounting', navModules: ['assets'] },
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
  if (def.parentKey && !featureEnabled(state, def.parentKey)) return false
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

/**
 * `multiSubsidiary` has a DATA-DEPENDENT default: on iff the org already runs
 * more than one subsidiary. This keeps existing multi-entity orgs working when
 * the flag was never explicitly set, and lets a single-entity org opt in to add
 * its first extra subsidiary. An explicit stored boolean always wins.
 */
async function resolveMultiSubsidiary(orgId: string, state: FeatureState): Promise<boolean> {
  const v = state?.multiSubsidiary
  if (typeof v === 'boolean') return v
  const r = (await db.execute(sql`
    select count(*)::int as n from subsidiaries
     where org_id = ${orgId} and is_active and not is_elimination`)) as unknown as { rows: { n: number }[] }
  return (r.rows[0]?.n ?? 0) > 1
}

/** Is multi-subsidiary on for this org (with the data-dependent default)? */
export async function subsidiaryFeatureEnabled(orgId: string): Promise<boolean> {
  return resolveMultiSubsidiary(orgId, await orgFeatureState(orgId))
}

/**
 * `multiCurrency` default: on iff the org has already touched foreign currency —
 * either posted a foreign-currency line (fx_rate <> 1) or configured any FX rate.
 * Keeps existing multi-currency orgs working when the flag was never set; an
 * explicit stored boolean always wins.
 */
async function resolveMultiCurrency(orgId: string, state: FeatureState): Promise<boolean> {
  const v = state?.multiCurrency
  if (typeof v === 'boolean') return v
  const r = (await db.execute(sql`
    select (
      exists(select 1 from journal_lines where org_id = ${orgId} and fx_rate <> 1)
      or exists(select 1 from fx_rates where org_id = ${orgId})
    ) as on`)) as unknown as { rows: { on: boolean }[] }
  return Boolean(r.rows[0]?.on)
}

/**
 * Feature state with data-dependent defaults resolved to explicit booleans
 * (currently just `multiSubsidiary`). Use this for the Features page and the
 * setup-rail gating so `featureEnabled` returns the correct value.
 */
export async function resolvedFeatureState(orgId: string): Promise<FeatureState> {
  const state = await orgFeatureState(orgId)
  const [multiSubsidiary, multiCurrency] = await Promise.all([
    resolveMultiSubsidiary(orgId, state),
    resolveMultiCurrency(orgId, state),
  ])
  return { ...state, multiSubsidiary, multiCurrency }
}

/** The set of nav module keys hidden by disabled features (for the resolver). */
export function hiddenNavModules(state: FeatureState): Set<string> {
  const hidden = new Set<string>()
  for (const f of FEATURES) {
    if (!featureEnabled(state, f.key)) for (const m of f.navModules ?? []) hidden.add(m)
  }
  return hidden
}

// --- Turn-off safety ---------------------------------------------------------
// One record class a feature "owns"; count is shown to the user so they know
// what turning the feature off affects.
export type FeatureImpact = { labelKey: string; count: number }
// `blocked` = accounting-integrity hard stop (data would be stranded/misstated).
// impacts present but not blocked = safe to disable after an informed confirm.
export type FeatureDisableStatus = { blocked: boolean; impacts: FeatureImpact[] }

async function countRows(query: SQL): Promise<number> {
  const r = (await db.execute(query)) as unknown as { rows: { n: number }[] }
  return Number(r.rows[0]?.n ?? 0)
}

/**
 * Per-feature "what happens if you turn this off" probe. A feature with no entry
 * toggles freely. `blocked` features cannot be disabled at all (enforced again in
 * the PUT route); the rest surface their impacts and confirm before disabling.
 * Keep each probe cheap (COUNTs) — they run on every Features page load.
 */
const FEATURE_DISABLE_CHECKS: Record<string, (orgId: string) => Promise<FeatureDisableStatus>> = {
  // Accounting integrity: the ledger is partitioned per subsidiary and history is
  // immutable, so once postings span >1 subsidiary you can't collapse to single-entity.
  multiSubsidiary: async (orgId) => {
    const n = await countRows(sql`
      select count(distinct subsidiary_id)::int as n from journal_lines where org_id = ${orgId}`)
    return { blocked: n > 1, impacts: n > 1 ? [{ labelKey: 'subsidiaryTxns', count: n }] : [] }
  },
  // Strict: a single foreign-currency posting makes the ledger's FX history
  // (rates, realized/unrealized gain-loss) load-bearing — can't revert to single-currency.
  multiCurrency: async (orgId) => {
    const n = await countRows(sql`
      select count(*)::int as n from journal_lines where org_id = ${orgId} and fx_rate <> 1`)
    return { blocked: n > 0, impacts: n > 0 ? [{ labelKey: 'foreignTxns', count: n }] : [] }
  },
  banking: async (orgId) => {
    const [recons, statements] = await Promise.all([
      countRows(sql`select count(*)::int as n from reconciliations where org_id = ${orgId}`),
      countRows(sql`select count(*)::int as n from bank_statements where org_id = ${orgId}`),
    ])
    const impacts: FeatureImpact[] = []
    if (recons) impacts.push({ labelKey: 'reconciliations', count: recons })
    if (statements) impacts.push({ labelKey: 'bankStatements', count: statements })
    return { blocked: false, impacts }
  },
  fixedAssets: async (orgId) => {
    const n = await countRows(sql`select count(*)::int as n from fixed_assets where org_id = ${orgId}`)
    return { blocked: false, impacts: n ? [{ labelKey: 'assets', count: n }] : [] }
  },
  inventory: async (orgId) => {
    const n = await countRows(sql`select count(*)::int as n from inventory_movements where org_id = ${orgId}`)
    return { blocked: false, impacts: n ? [{ labelKey: 'inventoryMovements', count: n }] : [] }
  },
  projects: async (orgId) => {
    const [all, active, billingRequests, payApplications, retainage, fieldTickets, projectDocuments, projectTime, changeOrders] = await Promise.all([
      countRows(sql`select count(*)::int as n from projects where org_id = ${orgId}`),
      countRows(sql`
        select count(*)::int as n from projects
         where org_id = ${orgId} and is_active
           and status not in ('closed', 'cancelled')`),
      countRows(sql`
        select count(*)::int as n from billing_requests
         where org_id = ${orgId} and status = 'open'`),
      countRows(sql`
        select count(*)::int as n from pay_applications
         where org_id = ${orgId} and status in ('draft', 'submitted', 'approved')`),
      countRows(sql`
        select count(*)::int as n
          from journal_lines jl
          join orgs o on o.id = jl.org_id
         where jl.org_id = ${orgId}
           and jl.account_id = nullif(o.settings->'controlAccounts'->>'retainageReceivable', '')::uuid
         group by jl.org_id
        having coalesce(sum(jl.amount), 0) <> 0`),
      countRows(sql`
        select count(*)::int as n from documents
         where org_id = ${orgId} and kind = 'field_ticket'
           and status in ('draft', 'pending_approval')`),
      countRows(sql`
        select count(*)::int as n from documents
         where org_id = ${orgId} and project_id is not null
           and kind <> 'field_ticket'
           and status in ('draft', 'pending_approval', 'approved')`),
      countRows(sql`
        select count(*)::int as n from time_entries
         where org_id = ${orgId} and project_id is not null
           and status in ('draft', 'submitted')`),
      countRows(sql`
        select count(*)::int as n from change_orders
         where org_id = ${orgId} and status = 'draft'`),
    ])
    const impacts: FeatureImpact[] = []
    if (all) impacts.push({ labelKey: 'projects', count: all })
    if (active) impacts.push({ labelKey: 'activeProjects', count: active })
    if (billingRequests) impacts.push({ labelKey: 'openProjectBillingRequests', count: billingRequests })
    if (payApplications) impacts.push({ labelKey: 'openPayApplications', count: payApplications })
    if (retainage) impacts.push({ labelKey: 'outstandingRetainage', count: retainage })
    if (fieldTickets) impacts.push({ labelKey: 'openFieldTickets', count: fieldTickets })
    if (projectDocuments) impacts.push({ labelKey: 'openProjectDocuments', count: projectDocuments })
    if (projectTime) impacts.push({ labelKey: 'openProjectTimeEntries', count: projectTime })
    if (changeOrders) impacts.push({ labelKey: 'openChangeOrders', count: changeOrders })
    return { blocked: active + billingRequests + payApplications + retainage + fieldTickets + projectDocuments + projectTime + changeOrders > 0, impacts }
  },
  fieldTickets: async (orgId) => {
    const n = await countRows(sql`
      select count(*)::int as n from documents
       where org_id = ${orgId} and kind = 'field_ticket'
         and status in ('draft', 'pending_approval')`)
    return { blocked: n > 0, impacts: n ? [{ labelKey: 'openFieldTickets', count: n }] : [] }
  },
  revenueRecognition: async (orgId) => {
    // Real usage = obligations on a NON-immediate rule (point_in_time recognizes
    // at invoice, so it isn't "using" deferral). A raw revenue_contracts count is
    // misleading — one is auto-created per invoice carrying any rev-rec item.
    const n = await countRows(sql`
      select count(*)::int as n
        from performance_obligations o
        join recognition_rules r on r.id = o.recognition_rule_id
       where o.org_id = ${orgId}
         and r.method <> 'point_in_time'
         and r.is_forecast = false
         and o.status <> 'cancelled'`)
    return { blocked: false, impacts: n ? [{ labelKey: 'revenueSchedules', count: n }] : [] }
  },
}

/** Whether a single feature is hard-blocked from being disabled (PUT-route guard). */
export async function featureDisableBlocked(orgId: string, key: string): Promise<boolean> {
  const check = FEATURE_DISABLE_CHECKS[key]
  if (!check) return false
  // Fail closed. A failed integrity probe must never be interpreted as proof
  // that a financial module is safe to disable.
  return (await check(orgId)).blocked
}

/** Disable status for each given (enabled) feature key; fail closed when an
 * integrity probe is unavailable. */
export async function featureDisableStatuses(
  orgId: string,
  keys: string[],
): Promise<Record<string, FeatureDisableStatus>> {
  const entries = await Promise.all(
    keys
      .filter((k) => FEATURE_DISABLE_CHECKS[k])
      .map(async (k) => {
        try {
          return [k, await FEATURE_DISABLE_CHECKS[k](orgId)] as const
        } catch {
          return [k, { blocked: true, impacts: [{ labelKey: 'controlCheckUnavailable', count: 1 }] }] as const
        }
      }),
  )
  return Object.fromEntries(entries)
}
