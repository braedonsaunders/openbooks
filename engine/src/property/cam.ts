/** CAM pools, finalization, reconciliation billing. Split from property/management.ts (ARCH-FILE-SPLIT; pure moves only). */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { createSubscriptionInvoice } from "../billing/subscription-billing.ts";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import { arePeriodModulesOpen } from "../periods/period-policy.ts";
import { add, cmp, mulPercent, mulRatio, neg, sum, toUnits } from "../money/money.ts";
import { addDays, dayCount } from "./management-foundation.ts";
import { assertEnabled, assertLockedSubsidiaryInScope, audit, exactMoney, lockPropertyInScope, PropertyManagementError, validDate, type CamAllocationDbRow, type CamLeaseRow, type CamPoolDbRow } from "./management-foundation.ts";
import { overlapDayCount } from "./management-foundation.ts";
import { propertyBillingGeneration } from "./rent-billing.ts";

/** Reusable conflict read mirroring the cam_pool_source_account_guard storage trigger. */
async function assertNoSharedSourceOverlap(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  propertyId: string,
  startsOn: string,
  endsOn: string,
  expenseAccountIds: string[],
  excludePoolId?: string,
): Promise<void> {
  const conflicts = (await tx.execute<{ name: string }>(sql`
    select cp.name from cam_pools cp
     where cp.org_id=${orgId} and cp.property_id=${propertyId} and cp.status<>'cancelled'
       and cp.period_starts_on<=${endsOn} and cp.period_ends_on>=${startsOn}
       ${excludePoolId ? sql`and cp.id<>${excludePoolId}` : sql``}
       and exists(
         select 1 from jsonb_array_elements_text(${JSON.stringify(expenseAccountIds)}::jsonb) wanted(account)
          where account in (select shared from jsonb_array_elements_text(cp.expense_account_ids) shared)
       )
     order by cp.created_at,cp.id limit 1`));
  const conflict = conflicts.rows[0];
  if (conflict) {
    throw new PropertyManagementError("CAM pools cannot overlap periods while sharing any expense account: "
      + `pool "${conflict.name}" already bills these sources for this property over an overlapping window`);
  }
}
/** Stable identity of a pool's source scope: the inputs any later reviewer can
 * re-derive from the period/location/account data to prove the audit evidence
 * still describes the source it was computed from. */
function camPoolSourceFingerprint(definition: {
  propertyId: string; fiscalYear: number; periodStartsOn: string; periodEndsOn: string;
  allocationBasis: string; budgetAmount: string; expenseAccountIds: string[];
}): string {
  return createHash("sha256").update(canonicalJson({
    kind: "cam_pool.v1",
    ...definition,
    expenseAccountIds: [...definition.expenseAccountIds].sort(),
  })).digest("hex");
}
export async function createCamPool(input: { orgId: string; actorId: string; allowedSubsidiaryIds: ReadonlySet<string> | null; propertyId: string; name: string; fiscalYear: number; periodStartsOn: string; periodEndsOn: string; allocationBasis: "rentable_area" | "equal" | "custom"; budgetAmount: string; expenseAccountIds: string[] }): Promise<{ id: string }> {
  const name = input.name.trim();
  const startsOn = validDate(input.periodStartsOn, "CAM period start")!;
  const endsOn = validDate(input.periodEndsOn, "CAM period end")!;
  const expenseAccountIds = [...new Set(input.expenseAccountIds)];
  const budgetAmount = exactMoney(input.budgetAmount, "CAM budget");
  if (!name || !Number.isInteger(input.fiscalYear) || endsOn < startsOn) throw new PropertyManagementError("CAM name, fiscal year, and a valid period are required");
  if (!["rentable_area", "equal", "custom"].includes(input.allocationBasis)) throw new PropertyManagementError("Invalid CAM allocation basis");
  if (!expenseAccountIds.length) throw new PropertyManagementError("Select at least one CAM expense account");
  return db.transaction(async (tx) => {
    await assertEnabled(tx, input.orgId);
    await lockPropertyInScope(tx, input.orgId, input.propertyId, input.allowedSubsidiaryIds);
    const accounts = (await tx.execute<{ n: number }>(sql`select count(*)::int as n from accounts where org_id=${input.orgId} and id::text in
      (select jsonb_array_elements_text(${JSON.stringify(expenseAccountIds)}::jsonb)) and type in ('expense','expense_other') and is_active and not is_summary`));
    if (accounts.rows[0]?.n !== expenseAccountIds.length) throw new PropertyManagementError("CAM accounts must be active posting expense accounts");
    await assertNoSharedSourceOverlap(tx, input.orgId, input.propertyId, startsOn, endsOn, expenseAccountIds);
    const result = (await tx.execute<{ id: string }>(sql`insert into cam_pools(org_id,property_id,name,fiscal_year,period_starts_on,period_ends_on,allocation_basis,budget_amount,expense_account_ids,status,created_by,updated_by)
      select ${input.orgId},id,${name},${input.fiscalYear},${startsOn},${endsOn},${input.allocationBasis},${budgetAmount},${JSON.stringify(expenseAccountIds)}::jsonb,'open',${input.actorId},${input.actorId}
        from managed_properties where org_id=${input.orgId} and id=${input.propertyId} and status='active' returning id`));
    if (!result.rows[0]) throw new PropertyManagementError("Active property not found");
    const id = result.rows[0].id;
    await audit(tx, input.orgId, "cam_pools", id, "insert", input.actorId, {
      propertyId: input.propertyId,
      before: null,
      after: { status: "open", name, fiscalYear: input.fiscalYear, periodStartsOn: startsOn, periodEndsOn: endsOn, allocationBasis: input.allocationBasis, budgetAmount, expenseAccountIds },
      sourceFingerprint: camPoolSourceFingerprint({ propertyId: input.propertyId, fiscalYear: input.fiscalYear, periodStartsOn: startsOn, periodEndsOn: endsOn, allocationBasis: input.allocationBasis, budgetAmount, expenseAccountIds }),
    });
    return { id };
  });
}
export async function updateCamPool(input: { orgId: string; actorId: string; allowedSubsidiaryIds: ReadonlySet<string> | null; poolId: string; name: string; fiscalYear: number; periodStartsOn: string; periodEndsOn: string; allocationBasis: "rentable_area" | "equal" | "custom"; budgetAmount: string; expenseAccountIds: string[] }): Promise<{ id: string }> {
  const name = input.name.trim();
  const startsOn = validDate(input.periodStartsOn, "CAM period start")!;
  const endsOn = validDate(input.periodEndsOn, "CAM period end")!;
  const expenseAccountIds = [...new Set(input.expenseAccountIds)];
  const budgetAmount = exactMoney(input.budgetAmount, "CAM budget");
  if (!name || !Number.isInteger(input.fiscalYear) || endsOn < startsOn) throw new PropertyManagementError("CAM name, fiscal year, and a valid period are required");
  if (!["rentable_area", "equal", "custom"].includes(input.allocationBasis)) throw new PropertyManagementError("Invalid CAM allocation basis");
  if (!expenseAccountIds.length) throw new PropertyManagementError("Select at least one CAM expense account");
  return db.transaction(async (tx) => {
    await assertEnabled(tx, input.orgId);
    const accounts = (await tx.execute<{ n: number }>(sql`select count(*)::int as n from accounts where org_id=${input.orgId} and id::text in
      (select jsonb_array_elements_text(${JSON.stringify(expenseAccountIds)}::jsonb)) and type in ('expense','expense_other') and is_active and not is_summary`));
    if (accounts.rows[0]?.n !== expenseAccountIds.length) throw new PropertyManagementError("CAM accounts must be active posting expense accounts");
    const editable = (await tx.execute<{
      propertyId: string; status: string; name: string; fiscalYear: number; periodStartsOn: string; periodEndsOn: string;
      allocationBasis: "rentable_area" | "equal" | "custom"; budgetAmount: string; expenseAccountIds: string[];
    }>(sql`select property_id as "propertyId",status,name,fiscal_year as "fiscalYear",period_starts_on::text as "periodStartsOn",
      period_ends_on::text as "periodEndsOn",allocation_basis as "allocationBasis",budget_amount::text as "budgetAmount",
      expense_account_ids as "expenseAccountIds"
      from cam_pools where org_id=${input.orgId} and id=${input.poolId} and status in ('draft','open') for update`));
    const before = editable.rows[0];
    if (!before) throw new PropertyManagementError("Editable CAM pool not found");
    const { propertyId: poolPropertyId, ...beforeSnapshot } = before;
    await lockPropertyInScope(tx, input.orgId, String(poolPropertyId), input.allowedSubsidiaryIds);
    await assertNoSharedSourceOverlap(tx, input.orgId, poolPropertyId, startsOn, endsOn, expenseAccountIds, input.poolId);
    await tx.execute(sql`
      update cam_pools set name=${name},fiscal_year=${input.fiscalYear},period_starts_on=${startsOn},period_ends_on=${endsOn},
        allocation_basis=${input.allocationBasis},budget_amount=${budgetAmount},expense_account_ids=${JSON.stringify(expenseAccountIds)}::jsonb,
        updated_at=now(),updated_by=${input.actorId}
      where org_id=${input.orgId} and id=${input.poolId} and status in ('draft','open')
    `);
    const snapshot = { status: beforeSnapshot.status, name, fiscalYear: input.fiscalYear, periodStartsOn: startsOn, periodEndsOn: endsOn, allocationBasis: input.allocationBasis, budgetAmount, expenseAccountIds };
    await audit(tx, input.orgId, "cam_pools", input.poolId, "update", input.actorId, {
      propertyId: poolPropertyId,
      before: beforeSnapshot,
      after: snapshot,
      sourceFingerprint: camPoolSourceFingerprint({ ...snapshot, propertyId: poolPropertyId }),
    });
    return { id: input.poolId };
  });
}
export async function cancelCamPool(orgId: string, actorId: string, allowedSubsidiaryIds: ReadonlySet<string> | null, poolId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await assertEnabled(tx, orgId);
    const anchor = (await tx.execute<{ property_id: string }>(sql`
      select property_id from cam_pools where org_id=${orgId} and id=${poolId} for update`)).rows[0];
    if (!anchor) throw new PropertyManagementError("Open CAM pool not found");
    await lockPropertyInScope(tx, orgId, String(anchor.property_id), allowedSubsidiaryIds);
    const result = (await tx.execute<{ name: string }>(sql`
      update cam_pools set status='cancelled',updated_at=now(),updated_by=${actorId}
      where org_id=${orgId} and id=${poolId} and status in ('draft','open') returning name
    `));
    if (!result.rows[0]) throw new PropertyManagementError("Open CAM pool not found");
    await audit(tx, orgId, "cam_pools", poolId, "cancel", actorId, { after: { status: "cancelled" }, name: result.rows[0].name });
  });
}
export async function reopenFinalizedCamPool(orgId: string, actorId: string, allowedSubsidiaryIds: ReadonlySet<string> | null, poolId: string, reason: string): Promise<void> {
  const correctionReason = reason.trim();
  if (!correctionReason) throw new PropertyManagementError("CAM correction reason is required");
  await db.transaction(async (tx) => {
    await assertEnabled(tx, orgId);
    const result = (await tx.execute<{ name: string; status: string; property_id: string }>(sql`
      select cp.name,cp.status,cp.property_id
      from cam_pools cp where cp.org_id=${orgId} and cp.id=${poolId} for update
    `));
    const pool = result.rows[0];
    if (!pool || pool.status !== "finalized") throw new PropertyManagementError("Finalized CAM pool not found");
    await lockPropertyInScope(tx, orgId, String(pool.property_id), allowedSubsidiaryIds);
    // A subquery evaluated before the pool lock wait can miss the biller that
    // just committed. Read dependencies in a new statement after owning the lock.
    const billed = (await tx.execute(sql`select id from cam_allocations
      where org_id=${orgId} and pool_id=${poolId} and invoice_document_id is not null limit 1`));
    if (billed.rows.length) throw new PropertyManagementError("An invoiced CAM pool is immutable; correct the tenant documents and create a supplemental pool");
    await tx.execute(sql`delete from cam_allocations where org_id=${orgId} and pool_id=${poolId}`);
    await tx.execute(sql`update cam_pools set status='open',actual_amount=null,finalized_at=null,finalized_by=null,updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${poolId}`);
    await audit(tx, orgId, "cam_pools", poolId, "reopen", actorId, { reason: correctionReason, before: { status: "finalized" }, after: { status: "open" }, name: pool.name });
  });
}
export async function finalizeCamPool(orgId: string, actorId: string, allowedSubsidiaryIds: ReadonlySet<string> | null, poolId: string): Promise<{ actualAmount: string; allocations: number }> {
  return db.transaction(async (tx) => {
    await assertEnabled(tx, orgId);
    const poolResult = (await tx.execute<CamPoolDbRow>(sql`select cp.*,p.location_id,p.subsidiary_id,p.currency from cam_pools cp join managed_properties p on p.id=cp.property_id and p.org_id=cp.org_id where cp.org_id=${orgId} and cp.id=${poolId} for update`));
    const pool = poolResult.rows[0]; if (!pool || !["draft","open"].includes(pool.status)) throw new PropertyManagementError("Open CAM pool not found");
    // The pool+property join above locks both rows: the subsidiary read is
    // current, so the scope recheck closes the rehome window.
    assertLockedSubsidiaryInScope(allowedSubsidiaryIds, pool.subsidiary_id);
    if (!pool.location_id) throw new PropertyManagementError("Property needs a location dimension before CAM actuals can be calculated");

    // A tenant recovers one economic cost, irrespective of its parallel book
    // representations. The primary posting book is the authoritative CAM
    // basis; retain that identity through finalization and record it in audit.
    const books = (await tx.execute<{ id: string; is_active: boolean; posts_gl: boolean }>(sql`
      select id,is_active,posts_gl from accounting_books
       where org_id=${orgId} and is_primary order by id for share`)).rows;
    if (books.length !== 1 || !books[0]!.is_active || !books[0]!.posts_gl) {
      throw new PropertyManagementError("CAM actuals require exactly one active primary posting book");
    }
    const bookId = books[0]!.id;
    const subsidiary = (await tx.execute<{ base_currency: string }>(sql`
      select base_currency from subsidiaries where org_id=${orgId} and id=${pool.subsidiary_id}
        and is_active and not is_elimination for share`)).rows[0];
    if (!subsidiary || pool.currency !== subsidiary.base_currency) {
      throw new PropertyManagementError("CAM actuals require the property currency to match its active subsidiary's functional currency");
    }

    // A finalized pool's actuals are immutable, but the source GL is live:
    // an expense posted into the covered window after the sum below yet
    // before this commit would be silently missing from the finalized pool.
    // Guard the whole [gate -> read -> compute -> commit] window with BOTH:
    //
    // 1. FENCE - take the EXCLUSIVE side of the exact advisory keys journal
    //    mutations hold SHARED across their own period-state check
    //    (period_posting_fence, migration 0022) and period close/reopen
    //    writers take exclusively (periodScopeAdvisoryLock). Every covered
    //    posting therefore either fully commits before our reads begin, and
    //    is counted by them, or parks behind this transaction until it ends -
    //    where its own closed-module check rejects it. Scope covers every
    //    authoritative book and every period overlapping the CAM dates, standard or
    //    adjustment; ordering by (period, book) keeps concurrent finalizations
    //    deadlock-free.
    const coveredScopes = (await tx.execute<{ period_id: string; book_id: string }>(sql`
      select p.id as period_id,b.id as book_id from accounting_periods p
        join accounting_books b on b.org_id=${orgId} and b.id=${bookId}
        where p.org_id=${orgId} and p.starts_on<=${pool.period_ends_on} and p.ends_on>=${pool.period_starts_on}
        order by p.id,b.id`));
    if (!coveredScopes.rows.length) throw new PropertyManagementError("No accounting periods overlap the CAM pool's dates");
    for (const scope of coveredScopes.rows) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`period-lock:${orgId}:${scope.period_id}:${scope.book_id}`}, 0))`);
    }
    // 2. GATE - require those GL modules CLOSED at the property's subsidiary,
    //    so a queued journal cannot merely wait out finalization and post late.
    //    One period gate: the shared GL check replaces the raw
    //    period_module_is_closed predicate, read in the closed sense. A
    //    source-owned imported lock counts as closed here exactly as before —
    //    finalization only observes closure, it never posts into the period.
    const gateScopes = (await tx.execute<{ period_id: string; book_id: string; name: string; code: string }>(sql`
      select p.id as period_id,b.id as book_id,p.name,b.code from accounting_periods p
        join accounting_books b on b.org_id=${orgId} and b.id=${bookId}
        where p.org_id=${orgId} and p.starts_on<=${pool.period_ends_on} and p.ends_on>=${pool.period_starts_on}
        order by p.name,b.code`));
    for (const scope of gateScopes.rows) {
      if (await arePeriodModulesOpen(tx, {
        orgId, periodId: scope.period_id, bookId: scope.book_id,
        subsidiaryIds: [pool.subsidiary_id], modules: ["gl"],
      })) {
        throw new PropertyManagementError(`Close the GL module for ${scope.name} in book ${scope.code} before finalizing CAM actuals`);
      }
    }
    // A void means the transaction never happened: exclude every line of a
    // voided document — the in-window original (status 'reversed') AND its
    // reversal, which the void posts in a later period outside this window.
    // Counting the original without its out-of-window offset would bill
    // tenants for voided costs. Manual corrections carry no document and
    // are unaffected: both legs still net inside the window as before.
    const sourceTotals = () => tx.execute<{ amount: string; lines: number; last_change: string }>(sql`
      select coalesce(sum(jl.amount),0)::text as amount, count(*)::int as lines,
        coalesce(max(greatest(je.posted_at,je.updated_at))::text,'') as last_change
      from journal_lines jl join journal_entries je on je.id=jl.entry_id and je.org_id=jl.org_id
      left join documents vd on vd.id = je.source_document_id and vd.org_id = jl.org_id
      where jl.org_id=${orgId} and je.book_id=${bookId} and jl.subsidiary_id=${pool.subsidiary_id}
        and je.status in ('posted','reversed') and je.posting_date between ${pool.period_starts_on} and ${pool.period_ends_on} and jl.location_id=${pool.location_id}
        and (vd.id is null or vd.status <> 'voided')
        and jl.account_id::text in(select jsonb_array_elements_text(${JSON.stringify(pool.expense_account_ids)}::jsonb))`);
    const actual = await sourceTotals();
    const actualAmount = exactMoney(actual.rows[0]?.amount ?? "0", "CAM actual amount");
    if (cmp(actualAmount, "0") < 0) throw new PropertyManagementError("CAM expense activity is net-negative; review the selected accounts before finalizing");
    // Weight fence: the sealed allocations and the fingerprint below are a
    // function of lease.cam_share_percent and unit.rentable_area, so the
    // rows that source them are locked FOR SHARE for the whole finalization,
    // in deterministic id order. updatePropertyLease and updatePropertyUnit
    // both hold their rows FOR UPDATE, which conflicts with FOR SHARE in
    // both directions: a concurrent edit either commits before these locks
    // are taken (and is counted) or parks behind this transaction until it
    // ends. New units cannot move a sealed weight — only an edit to an
    // overlapping lease or its unit can, and both are covered.
    await tx.execute(sql`
      select l.id from property_leases l where l.org_id=${orgId} and l.property_id=${pool.property_id}
        and l.cam_method='pro_rata' and l.status not in ('draft','cancelled') and l.starts_on<=${pool.period_ends_on}
        and coalesce(l.move_out_on,l.ends_on,${pool.period_ends_on})>=${pool.period_starts_on}
      order by l.id for share`);
    await tx.execute(sql`
      select u.id from property_units u where u.org_id=${orgId} and u.id in (
        select l.unit_id from property_leases l where l.org_id=${orgId} and l.property_id=${pool.property_id}
          and l.cam_method='pro_rata' and l.status not in ('draft','cancelled') and l.starts_on<=${pool.period_ends_on}
          and coalesce(l.move_out_on,l.ends_on,${pool.period_ends_on})>=${pool.period_starts_on}
          and l.unit_id is not null)
      order by u.id for share`);
    const leases = (await tx.execute<CamLeaseRow>(sql`select l.id,l.lease_number,l.cam_share_percent,u.rentable_area,
      greatest(l.starts_on,coalesce(l.move_in_on,l.starts_on),${pool.period_starts_on}::date)::text as overlap_start,
      least(coalesce(l.move_out_on,l.ends_on,${pool.period_ends_on}::date),${pool.period_ends_on}::date)::text as overlap_end,
      coalesce((select sum(s.amount) from lease_schedule_lines s join lease_charges c on c.id=s.charge_id and c.org_id=s.org_id
        join documents d on d.id=s.invoice_document_id and d.org_id=s.org_id and d.status<>'voided'
        where s.org_id=l.org_id and s.lease_id=l.id and c.charge_type='cam' and s.status='invoiced'
          and s.period_starts_on<=${pool.period_ends_on} and s.period_ends_on>=${pool.period_starts_on}),0)::text as billed
      from property_leases l left join property_units u on u.id=l.unit_id and u.org_id=l.org_id where l.org_id=${orgId} and l.property_id=${pool.property_id}
        and l.cam_method='pro_rata' and l.status not in ('draft','cancelled') and l.starts_on<=${pool.period_ends_on}
        and coalesce(l.move_out_on,l.ends_on,${pool.period_ends_on})>=${pool.period_starts_on}
      order by l.id`));
    if (!leases.rows.length) throw new PropertyManagementError("No pro-rata CAM leases overlap this period");
    const poolDays = dayCount(pool.period_starts_on, pool.period_ends_on);
    // Lease-id order everywhere below: the allocation, the rounding residual,
    // and the fingerprint are pure functions of the sources, never of the
    // physical row order the planner happens to return.
    const measured = leases.rows.map((lease) => {
      const days = overlapDayCount(lease.overlap_start, lease.overlap_end, pool.period_starts_on, pool.period_ends_on);
      const basis = pool.allocation_basis === "equal" ? 10_000n
        : pool.allocation_basis === "rentable_area" ? toUnits(lease.rentable_area ?? "0")
          : toUnits(lease.cam_share_percent ?? "0");
      return { ...lease, days, weight: basis * BigInt(days) };
    });
    // An overlapping lease with no basis used to be filtered out below, so
    // its share silently moved to the remaining leases (one area-less lease
    // beside a 100 sqft one billed the other 100% of the pool). A missing
    // basis is a data refusal that names every affected lease, never a
    // zero weight. Leases with no overlap days are legitimately excluded.
    if (pool.allocation_basis !== "equal") {
      const unpriced = measured.filter((lease) => lease.days > 0 && lease.weight <= 0n);
      if (unpriced.length) {
        const numbers = unpriced.map((lease) => lease.lease_number).join(", ");
        throw new PropertyManagementError(pool.allocation_basis === "rentable_area"
          ? `CAM finalization needs a rentable area for every overlapping lease: ${numbers} overlap this period with no unit or zero rentable area — assign each lease a unit with positive rentable area before finalizing`
          : `CAM finalization needs a custom CAM share for every overlapping lease: ${numbers} overlap this period with no positive CAM share — set each lease's CAM share before finalizing`);
      }
    }
    const weighted = measured.filter((lease) => lease.days > 0 && lease.weight > 0n);
    if (!weighted.length) throw new PropertyManagementError(pool.allocation_basis === "rentable_area"
      ? "Overlapping CAM leases need positive rentable area" : "Overlapping CAM leases need a positive allocation weight");
    const totalWeight = weighted.reduce((total, lease) => total + lease.weight, 0n);
    // Rounding residual convention: the largest weight absorbs it (smallest
    // relative distortion); ties go to the lowest lease id.
    const residualIndex = pool.allocation_basis === "custom" ? -1
      : weighted.reduce((best, lease, index) => lease.weight > weighted[best]!.weight ? index : best, 0);
    const shares: string[] = weighted.map((lease, index) => {
      if (pool.allocation_basis === "custom") return mulRatio(exactMoney(lease.cam_share_percent, "CAM share"), BigInt(lease.days), BigInt(poolDays));
      return index === residualIndex ? "0.0000" : mulRatio("100", lease.weight, totalWeight);
    });
    if (residualIndex >= 0) shares[residualIndex] = add("100", neg(sum(shares)));
    if (pool.allocation_basis === "custom" && cmp(sum(shares), "100") > 0) {
      throw new PropertyManagementError("Time-weighted custom CAM shares exceed 100%");
    }
    const budgetAllocations = shares.map((share, index) => index === residualIndex ? "0.0000" : mulPercent(pool.budget_amount, share));
    const actualAllocations = shares.map((share, index) => index === residualIndex ? "0.0000" : mulPercent(actualAmount, share));
    if (residualIndex >= 0) {
      budgetAllocations[residualIndex] = add(pool.budget_amount, neg(sum(budgetAllocations)));
      actualAllocations[residualIndex] = add(actualAmount, neg(sum(actualAllocations)));
    }
    // Commit-time consistency proof: the fences above seal the kernel's
    // posting paths, but a write that bypassed the covered scopes entirely
    // (e.g. an incoherent explicit period override) would still be invisible
    // to both. Re-reading the exact source predicate immediately before
    // committing turns any residual change into a refused finalization
    // instead of stale immutable actuals.
    const verified = await sourceTotals();
    if (verified.rows[0]!.lines !== actual.rows[0]!.lines || verified.rows[0]!.amount !== actual.rows[0]!.amount || verified.rows[0]!.last_change !== actual.rows[0]!.last_change) {
      throw new PropertyManagementError("CAM source ledgers changed while finalizing; resolve the entries and retry");
    }
    const finalizeSourceFingerprint = createHash("sha256").update(canonicalJson({
      kind: "cam_finalize.v3",
      poolId,
      propertyId: pool.property_id,
      bookId,
      subsidiaryId: pool.subsidiary_id,
      currency: pool.currency,
      periodStartsOn: pool.period_starts_on,
      periodEndsOn: pool.period_ends_on,
      locationId: pool.location_id,
      allocationBasis: pool.allocation_basis,
      expenseAccountIds: [...pool.expense_account_ids].sort(),
      budgetAmount: pool.budget_amount,
      actualAmount,
      // Each share is bound to its lease (v2); a detached share list could
      // match while the residual sat on a different tenant.
      sources: weighted.map((lease, index) => ({
        leaseId: lease.id, days: lease.days, weight: lease.weight.toString(), billed: lease.billed, share: shares[index]!,
      })),
    })).digest("hex");
    await tx.execute(sql`delete from cam_allocations where org_id=${orgId} and pool_id=${poolId}`);
    for (const [index, lease] of weighted.entries()) {
      const share = shares[index]!;
      const budgetAllocation = budgetAllocations[index]!; const actualAllocation = actualAllocations[index]!;
      await tx.execute(sql`insert into cam_allocations(org_id,pool_id,lease_id,share_percent,budget_allocation,actual_allocation,billed_estimate,reconciliation_amount,created_by,updated_by)
        values(${orgId},${poolId},${lease.id},${share},${budgetAllocation},${actualAllocation},${lease.billed},${add(actualAllocation,neg(lease.billed))},${actorId},${actorId})`);
    }
    await tx.execute(sql`update cam_pools set actual_amount=${actualAmount},status='finalized',finalized_at=now(),finalized_by=${actorId},updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${poolId}`);
    await audit(tx, orgId, "cam_pools", poolId, "finalize", actorId, {
      locationId: pool.location_id,
      bookId,
      subsidiaryId: pool.subsidiary_id,
      currency: pool.currency,
      before: { status: pool.status },
      after: { status: "finalized", actualAmount, allocationCount: weighted.length, budgetAllocationTotal: sum(budgetAllocations), actualAllocationTotal: sum(actualAllocations) },
      sourceFingerprint: finalizeSourceFingerprint,
    });
    return { actualAmount, allocations: weighted.length };
  });
}
export async function billCamReconciliation(orgId: string, actorId: string, allowedSubsidiaryIds: ReadonlySet<string> | null, poolId: string, invoiceDate?: string): Promise<{ documents: string[] }> {
  const date = validDate(invoiceDate ?? await businessToday(orgId), "CAM invoice date")!;
  await assertEnabled(db, orgId);
  // Discovery supplies identities only. Pool reopening and billing share the
  // pool lock, and complete invoice inputs are read under source/config locks.
  const allocations = (await db.execute<{ id: string }>(sql`
    select a.id from cam_allocations a join cam_pools cp on cp.id=a.pool_id and cp.org_id=a.org_id
    join managed_properties p on p.id=cp.property_id and p.org_id=cp.org_id
    where a.org_id=${orgId} and a.pool_id=${poolId} and cp.status in ('finalized','invoiced')
      and a.invoice_document_id is null and a.reconciliation_amount<>0
      ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)} order by a.id`));
  const documents: string[] = [];
  for (const candidate of allocations.rows) {
    await withOrgTransaction(orgId, async () => {
      const pool = (await db.execute(sql`select id from cam_pools where org_id=${orgId} and id=${poolId}
        and status in ('finalized','invoiced') for update`));
      if (!pool.rows[0]) return;
      await assertEnabled(db, orgId);
      const locked = (await db.execute<CamAllocationDbRow>(sql`
        select a.id,a.reconciliation_amount as amount,a.lease_id,l.tenant_id,l.lease_number,l.payment_terms_days,
          p.subsidiary_id,p.location_id,p.currency,p.cam_income_account_id,cp.name
        from cam_allocations a join cam_pools cp on cp.id=a.pool_id and cp.org_id=a.org_id
        join property_leases l on l.id=a.lease_id and l.org_id=a.org_id
        join managed_properties p on p.id=l.property_id and p.org_id=l.org_id
        where a.org_id=${orgId} and a.pool_id=${poolId} and a.id=${candidate.id}
          and a.invoice_document_id is null and a.reconciliation_amount<>0
        for update of a for share of l,p`));
      const row = locked.rows[0];
      if (!row) return;
      // The allocation read holds the pool FOR UPDATE and the lease and
      // property FOR SHARE: a concurrent rehome waits on the share lock,
      // so this subsidiary is current and the recheck closes the race.
      assertLockedSubsidiaryInScope(allowedSubsidiaryIds, row.subsidiary_id);
      if (!row.cam_income_account_id) throw new PropertyManagementError("Configure the property CAM income account first");
      const credit = cmp(row.amount, "0") < 0; const amount = credit ? neg(row.amount) : row.amount; const key = `cam:${poolId}:${row.id}`;
      const generation = await propertyBillingGeneration(orgId, key, credit ? "customer_credit" : "customer_invoice");
      let documentId = generation.documentId;
      if (!documentId) {
        const generated = await createSubscriptionInvoice({ orgId, actorId, customerId: row.tenant_id, subsidiaryId: row.subsidiary_id, locationId: row.location_id,
          currency: row.currency, incomeAccountId: row.cam_income_account_id, itemId: null, taxCodeId: null, description: `${row.name} CAM reconciliation`,
          quantity: "1", unitPrice: amount, memo: `${row.lease_number} · ${row.name}`, invoiceDate: date,
          dueDate: credit ? null : addDays(date, row.payment_terms_days), autoPost: false, applyTax: false, documentKind: credit ? "customer_credit" : "customer_invoice",
          custom: { propertyManagement: { billingKey: generation.generationKey, originalBillingKey: key,
            ...(generation.predecessorId ? { predecessorInvoiceId: generation.predecessorId } : {}),
            poolId, allocationId: row.id, leaseId: row.lease_id, kind: "cam_reconciliation" } } });
        documentId = generated.invoiceId;
      }
      await db.execute(sql`update cam_allocations set invoice_document_id=${documentId},updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${row.id} and invoice_document_id is null`);
      await audit(db, orgId, "cam_allocations", row.id, "invoice", actorId, {
        before: { invoiceDocumentId: null },
        after: { invoiceDocumentId: documentId },
        billingKey: key,
      });
      documents.push(documentId);
    });
  }
  await db.transaction(async (tx) => {
    // A missing pool stamps nothing (the update below affects zero rows);
    // a present one is locked and rechecked so a restricted caller cannot
    // flip another entity's pool after a rehome. Lock order is pool row, then
    // property, the same order reopenFinalizedCamPool takes: taking the
    // property first and the pool row at the update deadlocked against a
    // concurrent reopen.
    const anchor = (await tx.execute<{ property_id: string }>(sql`
      select property_id from cam_pools where org_id=${orgId} and id=${poolId} for update`)).rows[0];
    if (anchor) await lockPropertyInScope(tx, orgId, String(anchor.property_id), allowedSubsidiaryIds);
    const stamped = (await tx.execute<{ id: string }>(sql`
      update cam_pools cp set status='invoiced',updated_at=now(),updated_by=${actorId}
      where cp.org_id=${orgId} and cp.id=${poolId} and cp.status='finalized'
        and not exists(select 1 from cam_allocations a where a.org_id=cp.org_id and a.pool_id=cp.id and a.reconciliation_amount<>0 and a.invoice_document_id is null)
      returning id`));
    if (!stamped.rows[0]) return;
    await audit(tx, orgId, "cam_pools", poolId, "invoice", actorId, {
      before: { status: "finalized" },
      after: { status: "invoiced" },
      documents,
    });
  });
  return { documents };
}
