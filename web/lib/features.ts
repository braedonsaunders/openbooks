import 'server-only'
import { cache } from 'react'
import { sql, type SQL } from 'drizzle-orm'
import { activePostingPrimaryBookId } from '@openbooks/engine/src/platform/accounting-books.ts'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { db, type SqlExecutor } from '@openbooks/engine/src/platform/db.ts'
import { orderedNetOfCancelledSql } from '@openbooks/engine/src/records/order-line-remainders.ts'

import { FEATURES, featureEnabled, type FeatureState } from '@openbooks/engine/src/organization/feature-registry.ts'
import { acquireOrgFeatureGateLock } from '@openbooks/engine/src/organization/org-feature-lock.ts'
export { FEATURES, FEATURE_BY_KEY, featureEnabled, featureRequirements, type FeatureDef, type FeatureState } from '@openbooks/engine/src/organization/feature-registry.ts'
// One source defines the fence identity: the engine module below. This
// switchboard re-exports its key so every importer keeps working.
export { featureGateLockKey } from '@openbooks/engine/src/organization/org-feature-lock.ts'

import {
  featureEnabledFromState,
  isFeatureEnabled as readFeatureEnabled,
  orgFeatureState as readOrgFeatureState,
  resolvedFeatureState as readResolvedFeatureState,
} from '@openbooks/engine/organization/feature-state'
export { subsidiaryFeatureEnabled } from '@openbooks/engine/organization/feature-state'

// A page render asks the same feature questions from its layout, page, gates
// and helpers. Within one server render each organization's switches are read
// once; actions, route handlers and calls bound to a transaction executor read
// live, because React's request cache applies only while rendering.
const renderFeatureState = cache((orgId: string) => readOrgFeatureState(orgId))
const renderFeatureEnabled = cache(async (orgId: string, key: string) =>
  featureEnabledFromState(orgId, key, await renderFeatureState(orgId)))
const renderResolvedFeatureState = cache(async (orgId: string) => {
  const state = await renderFeatureState(orgId)
  const multiSubsidiary = await renderFeatureEnabled(orgId, 'multiSubsidiary')
  const multiCurrency = await renderFeatureEnabled(orgId, 'multiCurrency')
  return { ...state, multiSubsidiary, multiCurrency }
})

/** Load the org's feature state (raw overrides; combine with featureEnabled). */
export async function orgFeatureState(orgId: string, executor?: SqlExecutor): Promise<FeatureState> {
  return executor ? readOrgFeatureState(orgId, executor) : { ...(await renderFeatureState(orgId)) }
}

/** Feature state with the data-dependent defaults resolved to explicit booleans. */
export async function resolvedFeatureState(orgId: string, executor?: SqlExecutor): Promise<FeatureState> {
  return executor ? readResolvedFeatureState(orgId, executor) : { ...(await renderResolvedFeatureState(orgId)) }
}

/** Is this feature on for the org? Resolves the data-dependent defaults. */
export async function isFeatureEnabled(orgId: string, key: string, executor?: SqlExecutor): Promise<boolean> {
  return executor ? readFeatureEnabled(orgId, key, executor) : renderFeatureEnabled(orgId, key)
}

/** The registry as the switchboard tree reads it (category, parent,
 *  requirements, recommendations) — for surfaces that render the tree. */
export function featureTreeRows(): {
  key: string
  category: string
  group?: string
  parentKey?: string
  requiresAll?: string[]
  recommends?: string[]
}[] {
  return FEATURES.map((f) => ({
    key: f.key,
    category: f.category,
    ...(f.group ? { group: f.group } : {}),
    ...(f.parentKey ? { parentKey: f.parentKey } : {}),
    ...(f.requiresAll ? { requiresAll: [...f.requiresAll] } : {}),
    ...(f.recommends ? { recommends: [...f.recommends] } : {}),
  }))
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
       where d.org_id = ${orgId} and d.kind = 'pay_run' and d.status in ('posted', 'voided')`)
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
              and dl.quantity_billed < ${orderedNetOfCancelledSql('dl')}
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
    const bookId = await activePostingPrimaryBookId(orgId)
    const n = await countRows(sql`
      select count(distinct jl.subsidiary_id)::int as n
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
       where jl.org_id = ${orgId} and je.book_id = ${bookId}`)
    return { blocked: n > 1, impacts: n > 1 ? [{ labelKey: 'subsidiaryTxns', count: n }] : [] }
  },
  // Strict: a single foreign-currency posting makes the ledger's FX history
  // (rates, realized/unrealized gain-loss) load-bearing — can't revert to single-currency.
  multiCurrency: async (orgId) => {
    const bookId = await activePostingPrimaryBookId(orgId)
    const n = await countRows(sql`
      select count(*)::int as n
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
       where jl.org_id = ${orgId} and je.book_id = ${bookId} and jl.fx_rate <> 1`)
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
  // With Inventory off, sales post revenue with no COGS and no stock relief
  // and receipts create no layers. That is only sound once nothing is held:
  // stock on hand, open cost layers, unsettled negative stock, stock in
  // transit and open counts all block the switch until they are cleared.
  inventory: async (orgId) => {
    const [movements, onHand, provisional, inTransit, openCounts] = await sequential([
      () => countRows(sql`select count(*)::int as n from inventory_movements where org_id = ${orgId}`),
      () => countRows(sql`
        select count(distinct item_id)::int as n from cost_layers
         where org_id = ${orgId} and remaining_quantity > 0`),
      () => countRows(sql`
        select count(distinct item_id)::int as n from inventory_provisional_costs
         where org_id = ${orgId} and remaining_quantity > 0`),
      () => countRows(sql`select count(*)::int as n from transfer_orders where org_id = ${orgId} and status = 'in_transit'`),
      () => countRows(sql`
        select count(*)::int as n from stock_counts
         where org_id = ${orgId} and status in ('draft', 'counting', 'review')`),
    ])
    const impacts: FeatureImpact[] = []
    if (onHand) impacts.push({ labelKey: 'inventoryItemsOnHand', count: onHand })
    if (provisional) impacts.push({ labelKey: 'inventoryNegativeStock', count: provisional })
    if (inTransit) impacts.push({ labelKey: 'inventoryTransfersInTransit', count: inTransit })
    if (openCounts) impacts.push({ labelKey: 'inventoryOpenCounts', count: openCounts })
    if (movements) impacts.push({ labelKey: 'inventoryMovements', count: movements })
    return { blocked: onHand + provisional + inTransit + openCounts > 0, impacts }
  },
  projects: async (orgId) => {
    const bookId = await activePostingPrimaryBookId(orgId)
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
          join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
          join orgs o on o.id = jl.org_id
         where jl.org_id = ${orgId} and je.book_id = ${bookId}
           and jl.account_id = nullif(o.settings->'controlAccounts'->>'retainageReceivable', '')::uuid
           and not jl.is_open_item
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
  preBilling: async (orgId) => {
    const [worksheets, holds] = await sequential([
      () => countRows(sql`select count(*)::int as n from prebills where org_id = ${orgId} and status in ('draft', 'review', 'approved', 'customer_review')`),
      () => countRows(sql`select count(*)::int as n from prebill_holds where org_id = ${orgId} and released_at is null`),
    ])
    const impacts: FeatureImpact[] = []
    if (worksheets) impacts.push({ labelKey: 'openPrebills', count: worksheets })
    if (holds) impacts.push({ labelKey: 'activePrebillHolds', count: holds })
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
  allocations: async (orgId) => {
    // Turning allocations off hides every binding moment (entry, posting,
    // period, scheduler) but keeps rules, versions, runs, and lineage — so
    // nothing is stranded and the switch is never blocked. Counts tell the
    // operator what goes dark.
    const [rules, runs] = await sequential([
      () => countRows(sql`select count(*)::int as n from allocation_rules where org_id = ${orgId} and is_active`),
      () => countRows(sql`select count(*)::int as n from allocation_runs where org_id = ${orgId} and status = 'previewed'`),
    ])
    const impacts: FeatureImpact[] = []
    if (rules) impacts.push({ labelKey: 'activeAllocationRules', count: rules })
    if (runs) impacts.push({ labelKey: 'previewedAllocationRuns', count: runs })
    return { blocked: false, impacts }
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

/**
 * Acquire the org's feature-gate fence. The lock is transaction-scoped, so it
 * MUST be taken on the writer's transaction connection: inside
 * `withOrgTransaction` the default `db` routes to the pinned transaction,
 * otherwise pass that transaction's executor explicitly (on a pooled
 * autocommit connection the lock would release instantly and fence nothing).
 * This is the web-shaped alias (org first, pool default) over the single
 * engine implementation, so the disable path and every creator hash one key.
 */
export async function acquireFeatureGateLock(orgId: string, runner: SqlExecutor = db): Promise<void> {
  await acquireOrgFeatureGateLock(runner, orgId)
}

/**
 * One shared fenced Projects recheck for writers that attach project-linked
 * records outside the Projects domain's own creators: generic document
 * edits that set a header project, timesheet saves and time amendments that
 * insert project-carrying lines, and field-ticket crew/line writes on a
 * project ticket. Takes the per-org feature-gate fence (serializing against
 * the disable path's blocker checks, which count exactly these rows) and
 * rechecks the flag under a shared org-row lock (serializing against the
 * disable's exclusive flag write). Returns false when the gate is off; the
 * caller refuses with its own domain error so every surface keeps its
 * status contract. Call it inside the write transaction, on the writer's
 * runner, before the first project-linked insert — never a copy per route.
 */
export { checkProjectsWriteEnabled } from '@openbooks/engine/organization/feature-state'

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
