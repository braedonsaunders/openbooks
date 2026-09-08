import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { db, type SqlExecutor } from '@openbooks/engine/src/db.ts'

import { FEATURES, featureEnabled, type FeatureState } from '@openbooks/engine/src/feature-registry.ts'
export { FEATURES, FEATURE_BY_KEY, featureEnabled, featureRequirements, type FeatureDef, type FeatureState } from '@openbooks/engine/src/feature-registry.ts'

/** Load the org's feature state (raw overrides; combine with featureEnabled). */
export async function orgFeatureState(orgId: string, executor: SqlExecutor = db): Promise<FeatureState> {
  const r = (await executor.execute<{ f: FeatureState | null }>(sql`select settings->'features' as f from orgs where id = ${orgId}`))
  return r.rows[0]?.f ?? {}
}

/** Server helper for route guards: is this feature on for the org? */
export async function isFeatureEnabled(orgId: string, key: string, executor: SqlExecutor = db): Promise<boolean> {
  return featureEnabled(await orgFeatureState(orgId, executor), key)
}

/**
 * `multiSubsidiary` has a DATA-DEPENDENT default: on iff the org already runs
 * more than one subsidiary. This keeps existing multi-entity orgs working when
 * the flag was never explicitly set, and lets a single-entity org opt in to add
 * its first extra subsidiary. An explicit stored boolean always wins.
 */
async function resolveMultiSubsidiary(orgId: string, state: FeatureState, executor: SqlExecutor = db): Promise<boolean> {
  const v = state?.multiSubsidiary
  if (typeof v === 'boolean') return v
  const r = (await executor.execute<{ n: number }>(sql`
    select count(*)::int as n from subsidiaries
     where org_id = ${orgId} and is_active and not is_elimination`))
  return (r.rows[0]?.n ?? 0) > 1
}

/** Is multi-subsidiary on for this org (with the data-dependent default)? */
export async function subsidiaryFeatureEnabled(orgId: string, executor: SqlExecutor = db): Promise<boolean> {
  return resolveMultiSubsidiary(orgId, await orgFeatureState(orgId, executor), executor)
}

/**
 * `multiCurrency` default: on iff the org has already touched foreign currency —
 * either posted a foreign-currency line (fx_rate <> 1) or configured any FX rate.
 * Keeps existing multi-currency orgs working when the flag was never set; an
 * explicit stored boolean always wins.
 */
async function resolveMultiCurrency(orgId: string, state: FeatureState, executor: SqlExecutor = db): Promise<boolean> {
  const v = state?.multiCurrency
  if (typeof v === 'boolean') return v
  const r = (await executor.execute<{ on: boolean }>(sql`
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
export async function resolvedFeatureState(orgId: string, executor: SqlExecutor = db): Promise<FeatureState> {
  const state = await orgFeatureState(orgId, executor)
  const [multiSubsidiary, multiCurrency] = await sequential([
    () => resolveMultiSubsidiary(orgId, state, executor),
    () => resolveMultiCurrency(orgId, state, executor),
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
type Results<Fns extends readonly (() => Promise<unknown>)[]> = {
  [Index in keyof Fns]: Awaited<ReturnType<Fns[Index]>>
}

async function sequential<const Fns extends readonly (() => Promise<unknown>)[]>(
  fns: Fns,
): Promise<Results<Fns>> {
  const out: unknown[] = []
  for (const fn of fns) out.push(await fn())
  return out as Results<Fns>
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
