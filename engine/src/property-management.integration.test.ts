import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  PropertyManagementError,
  billCamReconciliation,
  cancelCamPool,
  createCamPool,
  finalizeCamPool,
  reopenFinalizedCamPool,
  updateCamPool,
} from "./property-management.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

const CONFLICT_MESSAGE =
  /CAM pools cannot overlap periods while sharing any expense account/u;

/** Storage-trigger errors arrive wrapped by Drizzle; walk the cause chain. */
function expectConflict(error: unknown): boolean {
  let cursor: unknown = error;
  for (let depth = 0; cursor instanceof Error && depth < 5; depth += 1) {
    if (CONFLICT_MESSAGE.test(cursor.message)) return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

const FORCED_AUDIT_FAILURE = /forced CAM audit failure/u;

function expectForcedAuditFailure(error: unknown): boolean {
  let cursor: unknown = error;
  for (let depth = 0; cursor instanceof Error && depth < 5; depth += 1) {
    if (FORCED_AUDIT_FAILURE.test(cursor.message)) return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

type CamAuditChanges = Record<string, unknown>;

interface CamAuditRow {
  changes: CamAuditChanges;
  actorId: string | null;
}

async function camAudits(orgId: string, table: string, rowId: string, action: string): Promise<CamAuditRow[]> {
  const result = (await db.execute<{ changes: CamAuditChanges; actorId: string | null }>(sql`
    select changes, actor_id as "actorId" from audit_log
     where org_id=${orgId} and table_name=${table} and row_id=${rowId} and action=${action}
     order by at asc, id asc`));
  return result.rows;
}

interface CamFixture {
  org: ScratchOrg;
  propertyId: string;
  ledgerAccount: string;
  disjointAccount: string;
}

async function seedCamProperty(): Promise<CamFixture> {
  const org = await createScratchOrg();
  await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{features}',
      coalesce(settings->'features','{}'::jsonb) || '{"propertyManagement": true}'::jsonb)
     where id = ${org.orgId}`);
  const propertyId = randomUUID();
  await db.execute(sql`
    insert into managed_properties
      (id, org_id, subsidiary_id, location_id, code, name, property_type, status, currency,
       rent_income_account_id, cam_income_account_id)
    values (${propertyId}, ${org.orgId}, ${org.subsidiaryId}, ${org.locationId}, 'PRP-CAM',
            'Shared Sources Tower', 'commercial', 'active', 'CAD',
            ${org.accounts.revenue}, ${org.accounts.revenue})`);
  // One pro-rata tenant covering the fixture's open period.
  await db.execute(sql`
    insert into property_leases
      (id, org_id, property_id, tenant_id, lease_number, status, starts_on, ends_on,
       cam_method, cam_share_percent)
    values (${randomUUID()}, ${org.orgId}, ${propertyId}, ${org.customerId}, 'LSE-CAM-1',
            'active', '2026-07-01', '2026-07-31', 'pro_rata', '100')`);
  return { org, propertyId, ledgerAccount: org.accounts.adjustment, disjointAccount: org.accounts.freight };
}

/** Posted GL activity feeding the pool's source account at the property location. */
async function postLedgerExpense(fixture: CamFixture, amount: string): Promise<void> {
  const entryId = randomUUID();
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
    values (${entryId}, ${fixture.org.orgId}, ${fixture.org.bookId}, ${fixture.org.subsidiaryId},
            ${`CAM-${entryId.slice(0, 8)}`}, '2026-07-15', ${fixture.org.periodId},
            'CAM source activity', 'draft', 'manual', null, null)`);
  await db.execute(sql`
    insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, location_id, amount, currency, txn_amount, fx_rate)
    values (${fixture.org.orgId}, ${entryId}, 1, ${fixture.ledgerAccount}, ${fixture.org.subsidiaryId},
            ${fixture.org.locationId}, ${amount}, 'CAD', ${amount}, 1),
           (${fixture.org.orgId}, ${entryId}, 2, ${fixture.org.accounts.bank}, ${fixture.org.subsidiaryId},
            null, ${`-${amount}`}, 'CAD', ${`-${amount}`}, 1)`);
  await db.execute(sql`
    update journal_entries set status = 'posted', posted_at = now(), updated_at = now(), updated_by = null
     where org_id = ${fixture.org.orgId} and id = ${entryId}`);
}

/** The sanctioned direct-seed GL close every finalizeCamPool caller needs.
 * locked_by carries a real user row, so the actor must be a real one too. */
async function closeGlModule(fixture: CamFixture, actorId: string): Promise<void> {
  await db.execute(sql`
    insert into period_locks
      (org_id, period_id, book_id, subsidiary_id, module, state, locked_at, locked_by, reason, created_by, updated_by)
    values (${fixture.org.orgId}, ${fixture.org.periodId}, ${fixture.org.bookId}, ${fixture.org.subsidiaryId},
            'gl', 'closed', now(), ${actorId}, 'CAM finalization requires frozen source periods',
            ${actorId}, ${actorId})`);
}

test("a shared-source expense feeds exactly one CAM reconciliation", { skip: !DB }, async () => {
  const fixture = await seedCamProperty();
  try {
    const actor = await createScratchUser(fixture.org.orgId, "CAM operator", "admin");
    await postLedgerExpense(fixture, "1000");
    const poolInputs = {
      orgId: fixture.org.orgId,
      actorId: actor,
      propertyId: fixture.propertyId,
      fiscalYear: 2026,
      periodStartsOn: "2026-07-01",
      periodEndsOn: "2026-07-31",
      allocationBasis: "equal" as const,
      budgetAmount: "500",
    };

    const primary = await createCamPool({ ...poolInputs, name: "FY26 CAM A", expenseAccountIds: [fixture.ledgerAccount] });
    assert.ok(primary.id);

    // Non-overlapping neighbours stay valid even when the accounts are identical…
    const neighbour = await createCamPool({
      ...poolInputs,
      name: "FY26 CAM AUG",
      periodStartsOn: "2026-08-01",
      periodEndsOn: "2026-08-31",
      expenseAccountIds: [fixture.ledgerAccount],
    });
    assert.ok(neighbour.id);
    // …and so do overlapped periods whose source accounts are disjoint.
    const disjoint = await createCamPool({
      ...poolInputs,
      name: "FY26 CAM B",
      expenseAccountIds: [fixture.disjointAccount],
    });
    assert.ok(disjoint.id);

    // API rejects a second open pool over the same window/accounts.
    await assert.rejects(
      () => createCamPool({ ...poolInputs, name: "FY26 CAM C", expenseAccountIds: [fixture.ledgerAccount] }),
      (error: unknown) => error instanceof PropertyManagementError && CONFLICT_MESSAGE.test(error.message),
    );

    // Storage rejects it too, for writers that never enter the engine.
    await assert.rejects(
      () => db.execute(sql`
        insert into cam_pools(org_id,property_id,name,fiscal_year,period_starts_on,period_ends_on,
          allocation_basis,budget_amount,expense_account_ids,status)
        values(${fixture.org.orgId},${fixture.propertyId},'FY26 RAW D',2026,'2026-07-01','2026-07-31',
          'equal','100',${JSON.stringify([fixture.ledgerAccount])}::jsonb,'open')`),
      expectConflict,
    );

    // The API also refuses to drag an editable pool into a shared-source overlap.
    await assert.rejects(
      () => updateCamPool({
        ...poolInputs,
        poolId: neighbour.id,
        name: "FY26 CAM AUG",
        periodStartsOn: "2026-07-01",
        periodEndsOn: "2026-07-31",
        budgetAmount: "500",
        expenseAccountIds: [fixture.ledgerAccount],
      }),
      (error: unknown) => error instanceof PropertyManagementError && CONFLICT_MESSAGE.test(error.message),
    );
    // And raw UPDATE writers hit the same storage guard.
    await assert.rejects(
      () => db.execute(sql`
        update cam_pools set period_starts_on='2026-07-01',period_ends_on='2026-07-31',
          expense_account_ids=${JSON.stringify([fixture.ledgerAccount])}::jsonb
         where org_id=${fixture.org.orgId} and id=${neighbour.id}`),
      expectConflict,
    );

    // Finalization is a financial commitment: the source GL period must be
    // closed before actuals can become immutable or be billed to tenants.
    await assert.rejects(
      () => finalizeCamPool(fixture.org.orgId, actor, primary.id),
      (error: unknown) => error instanceof PropertyManagementError && /Close the GL module/.test(error.message),
    );
    const untouched = (await db.execute<{
      status: string; actualAmount: string | null; allocations: number;
    }>(sql`
      select cp.status,cp.actual_amount::text as "actualAmount",
             (select count(*)::int from cam_allocations a where a.org_id=cp.org_id and a.pool_id=cp.id) as allocations
        from cam_pools cp where cp.org_id=${fixture.org.orgId} and cp.id=${primary.id}`)).rows[0]!;
    assert.equal(untouched.status, "open");
    assert.equal(untouched.actualAmount, null);
    assert.equal(untouched.allocations, 0);

    // Only one ordinary reconciliation exists for the ledger source: the survivor
    // finalizes against the full GL activity once, bills once, and rerunning is a no-op.
    await closeGlModule(fixture, actor);
    const finalized = await finalizeCamPool(fixture.org.orgId, actor, primary.id);
    assert.equal(finalized.actualAmount, "1000.0000");
    assert.equal(finalized.allocations, 1);
    const billed = await billCamReconciliation(fixture.org.orgId, actor, primary.id, "2026-07-15");
    assert.equal(billed.documents.length, 1);
    const rebilled = await billCamReconciliation(fixture.org.orgId, actor, primary.id, "2026-07-15");
    assert.deepEqual(rebilled.documents, []);
  } finally {
    await dropScratchOrg(fixture.org.orgId);
  }
});

test("two racing writers cannot both claim a shared-source CAM window", { skip: !DB }, async () => {
  const fixture = await seedCamProperty();
  try {
    const actor = await createScratchUser(fixture.org.orgId, "CAM operator", "admin");
    const poolInputs = {
      orgId: fixture.org.orgId,
      actorId: actor,
      propertyId: fixture.propertyId,
      fiscalYear: 2026,
      periodStartsOn: "2026-07-01",
      periodEndsOn: "2026-07-31",
      allocationBasis: "equal" as const,
      budgetAmount: "250",
    };
    const [first, second] = await Promise.allSettled([
      createCamPool({ ...poolInputs, name: "FY26 RACE 1", expenseAccountIds: [fixture.ledgerAccount] }),
      createCamPool({ ...poolInputs, name: "FY26 RACE 2", expenseAccountIds: [fixture.ledgerAccount] }),
    ]);
    assert.equal(first.status, "fulfilled");
    assert.equal(second.status, "rejected", "the racing twin must lose instead of double-billing");
    assert.ok(expectConflict(second.reason), `racing rejection must be the shared-source conflict: ${String(second.reason)}`);
    const claimed = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from cam_pools
       where org_id=${fixture.org.orgId} and property_id=${fixture.propertyId}
         and status <> 'cancelled'
         and period_starts_on <= '2026-07-31' and period_ends_on >= '2026-07-01'
         and expense_account_ids ?| array[${fixture.ledgerAccount}]::text[]`));
    assert.equal(claimed.rows[0]?.n, 1);
  } finally {
    await dropScratchOrg(fixture.org.orgId);
  }
});

test("cancelling a pool releases its shared sources for reuse", { skip: !DB }, async () => {
  const fixture = await seedCamProperty();
  try {
    const actor = await createScratchUser(fixture.org.orgId, "CAM operator", "admin");
    const poolInputs = {
      orgId: fixture.org.orgId,
      actorId: actor,
      propertyId: fixture.propertyId,
      fiscalYear: 2026,
      periodStartsOn: "2026-07-01",
      periodEndsOn: "2026-07-31",
      allocationBasis: "equal" as const,
      budgetAmount: "100",
      expenseAccountIds: [fixture.ledgerAccount],
    };
    const original = await createCamPool({ ...poolInputs, name: "FY26 RETIRED" });
    await cancelCamPool(fixture.org.orgId, actor, original.id);
    const replacement = await createCamPool({ ...poolInputs, name: "FY26 SUCCESSOR" });
    assert.ok(replacement.id);
    // While the competing open pool holds the sources, another challenger loses.
    await assert.rejects(
      () => createCamPool({ ...poolInputs, name: "FY26 CHALLENGER" }),
      (error: unknown) => error instanceof PropertyManagementError && CONFLICT_MESSAGE.test(error.message),
    );
  } finally {
    await dropScratchOrg(fixture.org.orgId);
  }
});

test("the CAM lifecycle commits before/after audit evidence with every transition", { skip: !DB }, async () => {
  const fixture = await seedCamProperty();
  try {
    const actor = await createScratchUser(fixture.org.orgId, "CAM auditor", "admin");
    await postLedgerExpense(fixture, "1000");
    const createInputs = {
      orgId: fixture.org.orgId,
      actorId: actor,
      propertyId: fixture.propertyId,
      name: "FY26 AUDIT",
      fiscalYear: 2026,
      periodStartsOn: "2026-07-01",
      periodEndsOn: "2026-07-31",
      allocationBasis: "equal" as const,
      budgetAmount: "500",
      expenseAccountIds: [fixture.ledgerAccount],
    };
    const created = await createCamPool(createInputs);

    // Create: null before → full source scope after, tied to a re-derivable fingerprint.
    const [insertAudit] = await camAudits(fixture.org.orgId, "cam_pools", created.id, "insert");
    assert.ok(insertAudit);
    assert.equal(insertAudit.actorId, actor);
    assert.deepEqual(insertAudit.changes.before ?? null, null);
    assert.deepEqual(insertAudit.changes.after, {
      status: "open",
      name: "FY26 AUDIT",
      fiscalYear: 2026,
      periodStartsOn: "2026-07-01",
      periodEndsOn: "2026-07-31",
      allocationBasis: "equal",
      budgetAmount: "500.0000",
      expenseAccountIds: [fixture.ledgerAccount],
    });
    const insertFingerprint = String(insertAudit.changes.sourceFingerprint);
    assert.match(insertFingerprint, /^[a-f0-9]{64}$/);

    // Update: the audit carries the true prior state next to the new one.
    const updated = await updateCamPool({ ...createInputs, poolId: created.id, name: "FY26 AUDIT REV", budgetAmount: "750" });
    assert.equal(updated.id, created.id);
    const [updateAudit] = await camAudits(fixture.org.orgId, "cam_pools", created.id, "update");
    assert.ok(updateAudit);
    assert.equal(updateAudit.actorId, actor);
    assert.deepEqual(updateAudit.changes.before, {
      status: "open",
      name: "FY26 AUDIT",
      fiscalYear: 2026,
      periodStartsOn: "2026-07-01",
      periodEndsOn: "2026-07-31",
      allocationBasis: "equal",
      budgetAmount: "500.0000",
      expenseAccountIds: [fixture.ledgerAccount],
    });
    assert.deepEqual((updateAudit.changes.after as Record<string, unknown>).name, "FY26 AUDIT REV");
    assert.equal((updateAudit.changes.after as Record<string, unknown>).budgetAmount, "750.0000");

    // Finalize: before/after statuses plus allocation totals that tie out to the pool.
    await closeGlModule(fixture, actor);
    const finalized = await finalizeCamPool(fixture.org.orgId, actor, created.id);
    assert.equal(finalized.actualAmount, "1000.0000");
    assert.equal(finalized.allocations, 1);
    const [finalizeAudit] = await camAudits(fixture.org.orgId, "cam_pools", created.id, "finalize");
    assert.ok(finalizeAudit);
    assert.equal(finalizeAudit.actorId, actor);
    assert.deepEqual(finalizeAudit.changes.before, { status: "open" });
    assert.deepEqual(finalizeAudit.changes.after, {
      status: "finalized",
      actualAmount: "1000.0000",
      allocationCount: 1,
      budgetAllocationTotal: "750.0000",
      actualAllocationTotal: "1000.0000",
    });
    const finalizeFingerprint = String(finalizeAudit.changes.sourceFingerprint);
    assert.match(finalizeFingerprint, /^[a-f0-9]{64}$/);

    // The fingerprint is source-derived: reopening and refinalizing unchanged
    // sources reproduces it exactly.
    await reopenFinalizedCamPool(fixture.org.orgId, actor, created.id, "audit determinism check");
    const refinalized = await finalizeCamPool(fixture.org.orgId, actor, created.id);
    assert.equal(refinalized.actualAmount, finalized.actualAmount);
    const [refinalizeAudit] = await camAudits(fixture.org.orgId, "cam_pools", created.id, "finalize").then((rows) => rows.slice(-1));
    assert.equal(String(refinalizeAudit?.changes.sourceFingerprint), finalizeFingerprint);

    // Invoice: both the per-allocation document link and the pool stamp are audited.
    const billed = await billCamReconciliation(fixture.org.orgId, actor, created.id, "2026-07-15");
    assert.equal(billed.documents.length, 1);
    const invoiceAudits = await camAudits(fixture.org.orgId, "cam_pools", created.id, "invoice");
    assert.equal(invoiceAudits.length, 1);
    assert.equal(invoiceAudits[0]!.actorId, actor);
    assert.deepEqual(invoiceAudits[0]!.changes, {
      before: { status: "finalized" },
      after: { status: "invoiced" },
      documents: billed.documents,
    });
    const allocationId = (await db.execute<{ id: string }>(sql`
      select id from cam_allocations where org_id=${fixture.org.orgId} and pool_id=${created.id}`)).rows[0]!.id;
    const linkAudits = await camAudits(fixture.org.orgId, "cam_allocations", allocationId, "invoice");
    assert.equal(linkAudits.length, 1);
    assert.equal(linkAudits[0]!.changes.after && (linkAudits[0]!.changes.after as Record<string, unknown>).invoiceDocumentId, billed.documents[0]);
    // Same audit row would have failed the transition had it not committed —
    // forced failure at finalize is proven by the dedicated crash test below;
    // these assertions prove every stage wrote its evidence.
    const pools = (await db.execute<{ status: string; actualAmount: string }>(sql`
      select status, actual_amount::text as "actualAmount" from cam_pools
       where org_id=${fixture.org.orgId} and id=${created.id}`)).rows[0]!;
    assert.equal(pools.status, "invoiced");
    assert.equal(pools.actualAmount, "1000.0000");
  } finally {
    await dropScratchOrg(fixture.org.orgId);
  }
});

test("forcing the CAM audit write to fail leaves no partial allocation or status change", { skip: !DB }, async () => {
  const fixture = await seedCamProperty();
  try {
    const actor = await createScratchUser(fixture.org.orgId, "CAM auditor", "admin");
    await postLedgerExpense(fixture, "400");
    const pool = await createCamPool({
      orgId: fixture.org.orgId,
      actorId: actor,
      propertyId: fixture.propertyId,
      name: "FY26 CRASH",
      fiscalYear: 2026,
      periodStartsOn: "2026-07-01",
      periodEndsOn: "2026-07-31",
      allocationBasis: "equal" as const,
      budgetAmount: "250",
      expenseAccountIds: [fixture.ledgerAccount],
    });
    await closeGlModule(fixture, actor);

    await db.execute(sql`
      create or replace function openbooks_forced_cam_audit_failure() returns trigger language plpgsql as $$
      begin raise exception 'forced CAM audit failure'; end $$`);
    let triggerInstalled = false;
    try {
      await db.execute(sql`
        create trigger forced_cam_audit_failure before insert on audit_log
          for each row when (new.table_name='cam_pools' and new.action='finalize')
          execute function openbooks_forced_cam_audit_failure()`);
      triggerInstalled = true;

      await assert.rejects(
        () => finalizeCamPool(fixture.org.orgId, actor, pool.id),
        expectForcedAuditFailure,
      );

      // The whole stage rolled back: no rebuilt allocations, no stamped actuals,
      // no moved status — nothing happened without its audit row.
      const survivor = (await db.execute<{
        status: string; allocations: number; actualAmount: string | null;
      }>(sql`
        select cp.status,(select count(*)::int from cam_allocations a where a.org_id=cp.org_id and a.pool_id=cp.id) as allocations,
               cp.actual_amount::text as "actualAmount"
        from cam_pools cp where cp.org_id=${fixture.org.orgId} and cp.id=${pool.id}`)).rows[0]!;
      assert.equal(survivor.status, "open");
      assert.equal(survivor.allocations, 0);
      assert.equal(survivor.actualAmount, null);
    } finally {
      if (triggerInstalled) await db.execute(sql`drop trigger forced_cam_audit_failure on audit_log`);
      await db.execute(sql`drop function if exists openbooks_forced_cam_audit_failure()`);
    }

    // With the saboteur gone, the same call commits the change together with its audit.
    const finalized = await finalizeCamPool(fixture.org.orgId, actor, pool.id);
    assert.equal(finalized.actualAmount, "400.0000");
    const audits = await camAudits(fixture.org.orgId, "cam_pools", pool.id, "finalize");
    assert.equal(audits.length, 1);
    assert.match(String(audits[0]!.changes.sourceFingerprint), /^[a-f0-9]{64}$/);
  } finally {
    await dropScratchOrg(fixture.org.orgId);
  }
});
