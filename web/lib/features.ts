import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
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
  /** Optional authoritative parent module. A child can never resolve enabled
   *  while its parent is disabled, regardless of stale stored overrides. */
  parentKey?: string
  /** Every listed feature must be enabled before this feature can resolve on.
   *  `parentKey` is the single-parent shorthand used by hierarchical modules;
   *  cross-module capabilities declare their complete dependency set. */
  requiresAll?: string[]
  /** Helpful companions shown on the Features page. Recommendations never
   *  prevent enablement because the underlying module remains independently useful. */
  recommends?: string[]
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
  // Contract-grade subscription lifecycle layered over the base recurring
  // plan/subscription engine: versioned catalog terms, components, trials,
  // amendments, renewals, co-terming, and advance/arrears timing.
  { key: 'advancedSubscriptions', defaultEnabled: false, category: 'sales', requiresAll: ['subscriptionBilling'] },
  // Online customer payments: hosted payment links on invoices (Stripe /
  // Adyen / GoCardless bank debit), surcharge rules, provider webhooks that
  // auto-apply receipts to open items. Off by default — manual receipts and
  // payment files work without it.
  { key: 'onlinePayments', defaultEnabled: false, category: 'sales' },
  // Operations
  // Projects is a parent gate on the centralized Features page.
  // Schedule-of-values billing remains a project-type procedure, not a gate.
  { key: 'projects', defaultEnabled: true, category: 'operations', navModules: ['projects', 'field-tickets', 'lien-waivers'] },
  { key: 'timeTracking', defaultEnabled: true, category: 'operations', navModules: ['timesheets'], parentKey: 'projects' },
  // Payroll — country-pack statutory engines (CA T4127, US Pub 15-T), pay
  // runs, stubs, remittance liabilities. Off by default: enabling payroll is
  // a deliberate adoption decision (TD1/W-4 profiles, control accounts,
  // schedules must be configured).
  { key: 'payroll', defaultEnabled: false, category: 'operations', navModules: ['payroll'], recommends: ['timeTracking'] },
  { key: 'fieldTickets', defaultEnabled: false, category: 'operations', navModules: ['field-tickets'], parentKey: 'projects' },
  // Project scheduling: critical-path Gantt, working calendars, baselines and
  // resource levelling. Off by default — a schedule is a planning instrument,
  // not an accounting one, and orgs that only job-cost projects should not
  // carry it. Subordinate to the Projects parent gate.
  //
  // The work-breakdown outline is NOT part of this gate, despite once being
  // described here as if it were. It is core Projects: the tasks it edits are
  // the job's own structure, `/api/projects/[id]/tasks` gates on Projects
  // accordingly, and the tab stays available to every org that runs projects.
  // Only the Schedule subtab and /api/project-schedule sit behind this key.
  { key: 'projectScheduling', defaultEnabled: false, category: 'operations', parentKey: 'projects' },
  // Vendor-side project commitments and AP progress billing. Purchase orders
  // and compliance make the workflow richer but are not required to account
  // for a direct subcontract.
  { key: 'subcontracts', defaultEnabled: false, category: 'operations', navModules: ['subcontracts'], requiresAll: ['projects'], recommends: ['orders', 'subcontractorCompliance'] },
  // Commercial review of billable project work before it reaches a customer
  // invoice. Time is a recommended source; project cost WIP works without it.
  { key: 'wipBilling', defaultEnabled: false, category: 'operations', navModules: ['wip-billing'], requiresAll: ['projects'], recommends: ['timeTracking'] },
  // Lease, rent, CAM, and deposit operations. A third-party manager may not
  // own the buildings or use separate legal entities, so adjacent accounting
  // capabilities are recommendations rather than hard dependencies.
  { key: 'propertyManagement', defaultEnabled: false, category: 'operations', navModules: ['property-management'], recommends: ['fixedAssets', 'multiSubsidiary', 'onlinePayments', 'revenueRecognition'] },
  // Subcontractor compliance: certificates of insurance, lien waivers, and
  // year-end information returns (1099-NEC/MISC, T4A) for the people you pay.
  // Off by default and deliberately NOT a child of `projects`: COI tracking and
  // 1099 filing are buy-side controls that stand on their own, and an org with
  // no projects still has subcontractors to vet. The lien-waiver surface is the
  // one part that needs a project, so it additionally requires the Projects
  // gate — enforced at its own page/API boundary, not by a parent gate that
  // would take insurance tracking down with it.
  { key: 'subcontractorCompliance', defaultEnabled: false, category: 'operations', navModules: ['compliance', 'compliance-vendors', 'lien-waivers', 'information-returns'] },
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
  { key: 'banking', defaultEnabled: true, category: 'accounting', navModules: ['banking', 'banking-cash', 'banking-transactions', 'banking-psp-settlements', 'banking-match', 'banking-recons', 'banking-rules', 'banking-imports'] },
  // Automated bank connectivity (SFTP file drops + Plaid/GoCardless/TrueLayer
  // live feeds). Off by default — manual OFX/CSV import always works without it.
  { key: 'bankFeeds', defaultEnabled: false, category: 'accounting' },
  { key: 'fixedAssets', defaultEnabled: true, category: 'accounting', navModules: ['assets', 'tax-depreciation'] },
  { key: 'budgets', defaultEnabled: true, category: 'accounting', navModules: ['budgets'] },
  { key: 'continuousClose', defaultEnabled: true, category: 'accounting', navModules: ['continuous-close'] },
  // Core period close is always available. This gate adds the mature-team
  // governance layer: evidence-heavy blueprints, independent approval flows,
  // and governed close-package publication. It depends on Flows because the
  // independent approval must be real at the service boundary, not a UI flag.
  { key: 'advancedClose', defaultEnabled: false, category: 'accounting', parentKey: 'flows' },
  // Platform
  { key: 'flows', defaultEnabled: true, category: 'platform', navModules: ['flows', 'approvals'] },
  { key: 'apps', defaultEnabled: true, category: 'platform', navModules: ['apps', 'admin-apps'] },
  { key: 'scripts', defaultEnabled: false, category: 'platform', navModules: ['admin-scripts'] },
  { key: 'apiAccess', defaultEnabled: false, category: 'platform', navModules: ['admin-api-keys', 'api-docs'] },
  { key: 'mcpAccess', defaultEnabled: false, category: 'platform', requiresAll: ['apiAccess'] },
  { key: 'queryConsole', defaultEnabled: false, category: 'platform', navModules: ['sql'] },
]

export const FEATURE_BY_KEY = new Map(FEATURES.map((f) => [f.key, f]))

export type FeatureState = Record<string, boolean>

/** Hard requirements for one feature, normalized across single-parent and
 * multi-dependency declarations. Stable ordering keeps UI/API errors deterministic. */
export function featureRequirements(def: FeatureDef): string[] {
  return [...new Set([...(def.parentKey ? [def.parentKey] : []), ...(def.requiresAll ?? [])])]
}

/** Pure: resolve one feature from a settings.features object. */
export function featureEnabled(
  state: FeatureState | null | undefined,
  key: string,
  resolving: Set<string> = new Set(),
): boolean {
  const def = FEATURE_BY_KEY.get(key)
  if (!def) return false
  // A registry cycle is invalid configuration. Fail closed instead of recursing
  // forever or exposing a partially gated module.
  if (resolving.has(key)) return false
  const nextResolving = new Set(resolving).add(key)
  if (featureRequirements(def).some((required) => !featureEnabled(state, required, nextResolving))) return false
  const v = state?.[key]
  return typeof v === 'boolean' ? v : def.defaultEnabled
}

/** Load the org's feature state (raw overrides; combine with featureEnabled). */
export async function orgFeatureState(orgId: string): Promise<FeatureState> {
  const r = (await db.execute<{ f: FeatureState | null }>(sql`select settings->'features' as f from orgs where id = ${orgId}`))
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
  const r = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from subsidiaries
     where org_id = ${orgId} and is_active and not is_elimination`))
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
  const r = (await db.execute<{ on: boolean }>(sql`
    select (
      exists(select 1 from journal_lines where org_id = ${orgId} and fx_rate <> 1)
      or exists(select 1 from fx_rates where org_id = ${orgId})
    ) as on`))
  return Boolean(r.rows[0]?.on)
}

/**
 * Feature state with data-dependent defaults resolved to explicit booleans
 * (currently just `multiSubsidiary`). Use this for the Features page and the
 * setup-rail gating so `featureEnabled` returns the correct value.
 */
export async function resolvedFeatureState(orgId: string): Promise<FeatureState> {
  const state = await orgFeatureState(orgId)
  const [multiSubsidiary, multiCurrency] = await sequential([
    () => resolveMultiSubsidiary(orgId, state),
    () => resolveMultiCurrency(orgId, state),
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
  const r = (await db.execute<{ n: number }>(query))
  return Number(r.rows[0]?.n ?? 0)
}

/**
 * Run probe subqueries strictly one at a time. Disable probes execute both on
 * the pool (Features page) and inside the org's fenced toggle transaction,
 * where every query shares ONE pinned client — and a PostgreSQL client must
 * never receive overlapping queries. Sequential is always safe; the counts are
 * cheap indexed aggregates.
 */
async function sequential<T>(fns: (() => Promise<T>)[]): Promise<T[]> {
  const out: T[] = []
  for (const fn of fns) out.push(await fn())
  return out
}

/**
 * Per-feature "what happens if you turn this off" probe. A feature with no entry
 * toggles freely. `blocked` features cannot be disabled at all (enforced again in
 * the PUT route); the rest surface their impacts and confirm before disabling.
 * Keep each probe cheap (COUNTs) — they run on every Features page load.
 */
const FEATURE_DISABLE_CHECKS: Record<string, (orgId: string) => Promise<FeatureDisableStatus>> = {
  payroll: async (orgId) => {
    // Posted pay runs are ledger history; the module cannot be turned off
    // once payroll has hit the GL (accounting-integrity hard stop).
    const n = await countRows(sql`
      select count(*)::int as n
        from documents d
       where d.org_id = ${orgId} and d.kind = 'pay_run' and d.status = 'posted'`)
    return {
      blocked: n > 0,
      impacts: n ? [{ labelKey: 'postedPayRuns', count: n }] : [],
    }
  },
  orders: async (orgId) => {
    const n = await countRows(sql`
      select count(*)::int as n
        from documents d
       where d.org_id = ${orgId}
         and d.kind in ('quote', 'sales_order', 'purchase_order')
         and d.status = 'approved'
         and exists (
           select 1 from document_lines dl
            where dl.document_id = d.id and dl.org_id = d.org_id
              and dl.quantity_billed < dl.quantity
         )`)
    return {
      blocked: n > 0,
      impacts: n ? [{ labelKey: 'openOrders', count: n }] : [],
    }
  },
  timeTracking: async (orgId) => {
    const n = await countRows(sql`
      select count(*)::int as n from time_entries
       where org_id = ${orgId} and status = 'submitted'`)
    return {
      blocked: n > 0,
      impacts: n ? [{ labelKey: 'submittedTimeEntries', count: n }] : [],
    }
  },
  bankFeeds: async (orgId) => {
    const [connections, schedules] = await sequential([
      () => countRows(sql`select count(*)::int as n from bank_feed_connections where org_id = ${orgId} and is_active`),
      () => countRows(sql`select count(*)::int as n from sftp_import_schedules where org_id = ${orgId} and is_active`),
    ])
    const impacts: FeatureImpact[] = []
    if (connections) impacts.push({ labelKey: 'activeBankFeeds', count: connections })
    if (schedules) impacts.push({ labelKey: 'activeBankImportSchedules', count: schedules })
    return { blocked: false, impacts }
  },
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
    const [recons, statements] = await sequential([
      () => countRows(sql`select count(*)::int as n from reconciliations where org_id = ${orgId}`),
      () => countRows(sql`select count(*)::int as n from bank_statements where org_id = ${orgId}`),
    ])
    const impacts: FeatureImpact[] = []
    if (recons) impacts.push({ labelKey: 'reconciliations', count: recons })
    if (statements) impacts.push({ labelKey: 'bankStatements', count: statements })
    return { blocked: false, impacts }
  },
  subscriptionBilling: async (orgId) => {
    const n = await countRows(sql`
      select count(*)::int as n from subscriptions
       where org_id = ${orgId} and status = 'active'`)
    // Silently stopping scheduled customer invoices is not a reversible display
    // preference. Administrators must pause or cancel active contracts first.
    return { blocked: n > 0, impacts: n ? [{ labelKey: 'activeSubscriptions', count: n }] : [] }
  },
  advancedSubscriptions: async (orgId) => {
    const n = await countRows(sql`
      select count(*)::int as n
        from subscription_lifecycles lifecycle
        join subscriptions subscription
          on subscription.id = lifecycle.subscription_id and subscription.org_id = lifecycle.org_id
       where lifecycle.org_id = ${orgId} and subscription.status = 'active'`)
    // A versioned active contract cannot be reinterpreted by another billing model.
    return { blocked: n > 0, impacts: n ? [{ labelKey: 'advancedSubscriptionContracts', count: n }] : [] }
  },
  scripts: async (orgId) => {
    const n = await countRows(sql`select count(*)::int as n from user_scripts where org_id = ${orgId} and is_active`)
    return { blocked: false, impacts: n ? [{ labelKey: 'activeScripts', count: n }] : [] }
  },
  apiAccess: async (orgId) => {
    const n = await countRows(sql`select count(*)::int as n from api_keys where org_id = ${orgId} and is_active`)
    return { blocked: false, impacts: n ? [{ labelKey: 'activeApiKeys', count: n }] : [] }
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
    const [all, active, billingRequests, payApplications, retainage, fieldTickets, projectDocuments, projectTime, changeOrders] = await sequential([
      () => countRows(sql`select count(*)::int as n from projects where org_id = ${orgId}`),
      () => countRows(sql`
        select count(*)::int as n from projects
         where org_id = ${orgId} and is_active
           and status not in ('closed', 'cancelled')`),
      () => countRows(sql`
        select count(*)::int as n from billing_requests
         where org_id = ${orgId} and status = 'open'`),
      () => countRows(sql`
        select count(*)::int as n from pay_applications
         where org_id = ${orgId} and status in ('draft', 'submitted', 'approved')`),
      () => countRows(sql`
        select count(*)::int as n
          from journal_lines jl
          join orgs o on o.id = jl.org_id
         where jl.org_id = ${orgId}
           and jl.account_id = nullif(o.settings->'controlAccounts'->>'retainageReceivable', '')::uuid
         group by jl.org_id
        having coalesce(sum(jl.amount), 0) <> 0`),
      () => countRows(sql`
        select count(*)::int as n from documents
         where org_id = ${orgId} and kind = 'field_ticket'
           and status in ('draft', 'pending_approval')`),
      () => countRows(sql`
        select count(*)::int as n from documents
         where org_id = ${orgId} and project_id is not null
           and kind <> 'field_ticket'
           and status in ('draft', 'pending_approval', 'approved')`),
      () => countRows(sql`
        select count(*)::int as n from time_entries
         where org_id = ${orgId} and project_id is not null
           and status in ('draft', 'submitted')`),
      () => countRows(sql`
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
  subcontracts: async (orgId) => {
    const [contracts, applications, controls] = await sequential([
      () => countRows(sql`select count(*)::int as n from subcontracts where org_id = ${orgId} and status not in ('closed', 'void')`),
      () => countRows(sql`select count(*)::int as n from vendor_pay_applications where org_id = ${orgId} and status in ('draft', 'submitted', 'approved')`),
      () => countRows(sql`select count(*)::int as n from subcontract_payment_controls where org_id = ${orgId} and status = 'active'`),
    ])
    const impacts: FeatureImpact[] = []
    if (contracts) impacts.push({ labelKey: 'activeSubcontracts', count: contracts })
    if (applications) impacts.push({ labelKey: 'openVendorPayApplications', count: applications })
    if (controls) impacts.push({ labelKey: 'activeSubcontractPaymentControls', count: controls })
    return { blocked: contracts + applications + controls > 0, impacts }
  },
  wipBilling: async (orgId) => {
    const [worksheets, holds] = await sequential([
      () => countRows(sql`select count(*)::int as n from wip_prebills where org_id = ${orgId} and status in ('draft', 'review', 'approved')`),
      () => countRows(sql`select count(*)::int as n from wip_holds where org_id = ${orgId} and released_at is null`),
    ])
    const impacts: FeatureImpact[] = []
    if (worksheets) impacts.push({ labelKey: 'openPrebills', count: worksheets })
    if (holds) impacts.push({ labelKey: 'activeWipHolds', count: holds })
    return { blocked: worksheets + holds > 0, impacts }
  },
  propertyManagement: async (orgId) => {
    const [leases, deposits] = await sequential([
      () => countRows(sql`select count(*)::int as n from property_leases where org_id=${orgId} and status in ('active','notice')`),
      () => countRows(sql`select count(*)::int as n from security_deposit_transactions where org_id=${orgId}`),
    ])
    const impacts: FeatureImpact[] = []
    if (leases) impacts.push({ labelKey: 'activePropertyLeases', count: leases })
    if (deposits) impacts.push({ labelKey: 'securityDepositTransactions', count: deposits })
    return { blocked: leases > 0, impacts }
  },
  // A schedule is planning data, never posted history, so turning it off is
  // always safe — but say how much plan goes dark before it happens.
  projectScheduling: async (orgId) => {
    const n = await countRows(sql`
      select count(*)::int as n from project_tasks
       where org_id = ${orgId} and schedule_start is not null`)
    return { blocked: false, impacts: n ? [{ labelKey: 'scheduledTasks', count: n }] : [] }
  },
  // Compliance evidence and information returns are records, not postings, so
  // switching the module off strands nothing — EXCEPT a finalized information
  // return that has not been filed yet. That is a statutory obligation in
  // flight: file it or void it before the module goes dark.
  subcontractorCompliance: async (orgId) => {
    const today = await businessToday(orgId)
    const [trackedVendors, activeRecords, blockingPolicies, openWaiverRequests, pendingFilings, unfiledFinalized] =
      await sequential([
        () => countRows(sql`
          select count(*)::int as n from vendor_roles
           where org_id = ${orgId} and compliance_class_id is not null and is_active`),
        () => countRows(sql`
          select count(*)::int as n from compliance_records
           where org_id = ${orgId} and status = 'active'
             and (expires_on is null or expires_on >= ${today})`),
        () => countRows(sql`
          select count(*)::int as n from compliance_requirements
           where org_id = ${orgId} and is_active
             and enforcement in ('block_payment', 'block_bill')`),
        () => countRows(sql`
          select count(*)::int as n from lien_waivers
           where org_id = ${orgId} and status in ('draft', 'requested', 'received')`),
        () => countRows(sql`
          select count(*)::int as n from information_return_filings
           where org_id = ${orgId} and status in ('draft', 'computed')`),
        () => countRows(sql`
          select count(*)::int as n from information_return_filings
           where org_id = ${orgId} and status = 'finalized'`),
      ])
    const impacts: FeatureImpact[] = []
    if (trackedVendors) impacts.push({ labelKey: 'trackedVendors', count: trackedVendors })
    if (activeRecords) impacts.push({ labelKey: 'activeCertificates', count: activeRecords })
    if (blockingPolicies) impacts.push({ labelKey: 'blockingCompliancePolicies', count: blockingPolicies })
    if (openWaiverRequests) impacts.push({ labelKey: 'openLienWaivers', count: openWaiverRequests })
    if (pendingFilings) impacts.push({ labelKey: 'draftInformationReturns', count: pendingFilings })
    if (unfiledFinalized) impacts.push({ labelKey: 'unfiledInformationReturns', count: unfiledFinalized })
    return { blocked: unfiledFinalized > 0, impacts }
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
        join recognition_rules r on r.id = o.recognition_rule_id and r.org_id = o.org_id
       where o.org_id = ${orgId}
         and r.method <> 'point_in_time'
         and r.is_forecast = false
         and o.status <> 'cancelled'`)
    return { blocked: false, impacts: n ? [{ labelKey: 'revenueSchedules', count: n }] : [] }
  },
}

// --- Turn-off vs turn-on serialization --------------------------------------
// The disable blockers and every operation that can CREATE a blocker (a project
// activating under the `projects` gate) must observe one serial order, or a
// disable could commit "feature off" after its blockers passed while an
// activation commits an active dependent — the exact state the blockers exist
// to prevent. Both sides take this deterministic per-org transaction-scoped
// advisory lock BEFORE evaluating gates/blockers and hold it to commit: the
// outcome is always a refused disable or a refused activation, never both
// applied. Transaction-scoped like every advisory lock in this codebase.

/** Stable fence identity for one org's feature switchboard. */
export function featureGateLockKey(orgId: string): string {
  return `openbooks:feature-gate:${orgId}`
}

/**
 * Acquire the org's feature-gate fence. MUST run inside `withOrgTransaction`:
 * the lock is transaction-scoped, so on a pooled autocommit connection it
 * would release instantly and fence nothing.
 */
export async function acquireFeatureGateLock(orgId: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${featureGateLockKey(orgId)}, 0))`)
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
 * integrity probe is unavailable. Keys are probed sequentially: these probes
 * also run inside the org's fenced toggle transaction, where every query
 * shares one pinned client that must never receive overlapping queries. */
export async function featureDisableStatuses(
  orgId: string,
  keys: string[],
): Promise<Record<string, FeatureDisableStatus>> {
  const entries: (readonly [string, FeatureDisableStatus])[] = []
  for (const k of keys.filter((key) => FEATURE_DISABLE_CHECKS[key])) {
    try {
      entries.push([k, await FEATURE_DISABLE_CHECKS[k]!(orgId)])
    } catch {
      entries.push([k, { blocked: true, impacts: [{ labelKey: 'controlCheckUnavailable', count: 1 }] }])
    }
  }
  return Object.fromEntries(entries)
}
