import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { setPeriodLockState } from "../close/close.ts";
import {
  createCamPool,
  finalizeCamPool,
  levelLeaseRentStraightLine,
  recordSecurityDeposit,
  reverseSecurityDepositTransaction,
} from "./management.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "../testing/fixtures.ts";

/**
 * One period gate for property management (fleet 8, P7): rent levelling,
 * security-deposit recording/reversal, and CAM finalization route through
 * assertPeriodModulesOpen / arePeriodModulesOpen instead of raw
 * period_module_is_closed SQL. Policy is preserved — every one of these
 * mints new local journals (or, for CAM, observes closure), so a
 * source-owned imported lock refuses exactly like a user lock wherever a
 * posting is at stake, and counts as closed where closure is the
 * precondition. Each path below pins both lock flavors.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

const IMPORTED_REASON = "close.importedPeriodLockReason";

/** User-owned close, through the same lock writer the close flow uses. */
async function closeGlForUser(org: ScratchOrg, actorId: string): Promise<void> {
  await setPeriodLockState({
    orgId: org.orgId,
    periodId: org.periodId,
    bookId: org.bookId,
    module: "gl",
    state: "closed",
    actorId,
    reason: "fleet8 f2: user-owned GL close",
  });
}

/**
 * Source-owned close, mirroring exactly what the migration mirror lands
 * (engine/src/sync/migrate.ts): every module locked with the imported reason.
 */
async function closeAllImported(org: ScratchOrg): Promise<void> {
  for (const module of ["ar", "ap", "banking", "assets", "tax", "gl"] as const) {
    await db.execute(sql`
      insert into period_locks
        (org_id, period_id, book_id, module, state, locked_at, reason)
      values (${org.orgId}, ${org.periodId}, ${org.bookId}, ${module},
              'closed', now(), ${IMPORTED_REASON})
      on conflict (org_id, period_id, book_id, subsidiary_id, module)
      do update set state = excluded.state,
        locked_at = excluded.locked_at,
        reason = excluded.reason,
        reopen_expires_at = null,
        version = period_locks.version + 1,
        updated_at = now()`);
  }
}

async function journalCount(orgId: string): Promise<number> {
  const r = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from journal_entries where org_id = ${orgId}`));
  return r.rows[0]!.n;
}

async function enableProperty(org: ScratchOrg, straightLineRentAccountId?: string): Promise<void> {
  await db.execute(sql`
    update orgs set settings = settings
      || ${JSON.stringify({ features: { propertyManagement: true } })}::jsonb
      ${straightLineRentAccountId ? sql`|| jsonb_build_object('controlAccounts',
           coalesce(settings->'controlAccounts', '{}'::jsonb) || ${JSON.stringify({ straightLineRent: straightLineRentAccountId })}::jsonb)` : sql``}
     where id = ${org.orgId}`);
}

/** Escalating annual lease whose year-one levelling accrues into open July. */
async function seedLevellingLease(org: ScratchOrg): Promise<string> {
  const slAccountId = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable,
                          required_dimensions, custom, subsidiary_include_children)
    values (${slAccountId}, ${org.orgId}, '1160', 'Straight-Line Rent Receivable', 'asset_current_other',
            false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
  await enableProperty(org, slAccountId);
  const propertyId = randomUUID();
  await db.execute(sql`
    insert into managed_properties
      (id, org_id, subsidiary_id, code, name, property_type, status, currency, address, custom,
       rent_income_account_id, created_by, updated_by)
    values (${propertyId}, ${org.orgId}, ${org.subsidiaryId}, 'PROP-F2', 'Gate Tower', 'commercial',
            'active', 'CAD', '{}'::jsonb, '{}'::jsonb, ${org.accounts.revenue}, null, null)`);
  const leaseId = randomUUID();
  await db.execute(sql`
    insert into property_leases
      (id, org_id, property_id, tenant_id, lease_number, status, starts_on, ends_on, billing_day,
       created_by, updated_by)
    values (${leaseId}, ${org.orgId}, ${propertyId}, ${org.customerId}, 'LSE-F2-LEVEL', 'active',
            '2025-07-01', '2030-06-30', 1, null, null)`);
  const amounts = ["10000", "11000", "12000", "13000", "14000"];
  for (let year = 0; year < 5; year++) {
    await db.execute(sql`
      insert into lease_charges
        (org_id, lease_id, charge_type, description, amount, frequency, effective_from, effective_to,
         income_account_id, created_by, updated_by)
      values (${org.orgId}, ${leaseId}, 'base_rent', ${`Year ${year + 1} rent`}, ${amounts[year]}, 'annually',
              ${`${2025 + year}-07-01`}, ${`${2026 + year}-06-30`}, ${org.accounts.revenue}, null, null)`);
  }
  return leaseId;
}

test("open period: rent levelling still posts (setup can post, refusal is load-bearing)", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const leaseId = await seedLevellingLease(org);
    const results = await levelLeaseRentStraightLine(org.orgId, null, { asOf: "2026-07-15", onlyLeaseId: leaseId });
    assert.equal(results.length, 1);
    assert.equal(results[0]!.delta, "2000.0000");
    assert.ok(results[0]!.entryId, "expected the accrual to post");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("rent levelling refuses a user-closed period", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const leaseId = await seedLevellingLease(org);
    await closeGlForUser(org, actorId);
    const before = await journalCount(org.orgId);
    await assert.rejects(
      levelLeaseRentStraightLine(org.orgId, null, { asOf: "2026-07-15", onlyLeaseId: leaseId }),
      /The GL period covering .* is closed; straight-line rent cannot post into it/,
      "levelling into a user-closed period must be refused",
    );
    assert.equal(await journalCount(org.orgId), before, "refused levelling left GL residue");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("rent levelling refuses a source-owned imported lock", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const leaseId = await seedLevellingLease(org);
    await closeAllImported(org);
    const before = await journalCount(org.orgId);
    await assert.rejects(
      levelLeaseRentStraightLine(org.orgId, null, { asOf: "2026-07-15", onlyLeaseId: leaseId }),
      /The GL period covering .* is closed; straight-line rent cannot post into it/,
      "levelling into an imported lock must be refused: the accrual is new activity, not replay",
    );
    assert.equal(await journalCount(org.orgId), before, "refused levelling left GL residue");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

async function seedDepositLease(org: ScratchOrg, tag: string): Promise<string> {
  await enableProperty(org);
  const propertyId = randomUUID();
  await db.execute(sql`insert into managed_properties
    (id,org_id,subsidiary_id,location_id,code,name,property_type,status,currency,rent_income_account_id,deposit_liability_account_id,default_bank_account_id)
    values(${propertyId},${org.orgId},${org.subsidiaryId},${org.locationId},
      ${`DEP-F2-${tag}`},${`Gate deposits ${tag}`},'commercial','active','CAD',${org.accounts.revenue},${org.accounts.deferred},${org.accounts.bank})`);
  const leaseId = randomUUID();
  await db.execute(sql`insert into property_leases(id,org_id,property_id,tenant_id,lease_number,status,starts_on)
    values(${leaseId},${org.orgId},${propertyId},${org.customerId},${`DEP-F2-${tag}`},'active',${org.date})`);
  return leaseId;
}

test("open period: a deposit still records (setup can post, refusal is load-bearing)", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const leaseId = await seedDepositLease(org, "open");
    const recorded = await recordSecurityDeposit({
      orgId: org.orgId, actorId, leaseId, occurredOn: org.date, kind: "received", amount: "100",
    });
    assert.equal(recorded.balance, "100.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("deposit recording refuses a user-closed period", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const leaseId = await seedDepositLease(org, "user");
    await closeGlForUser(org, actorId);
    await assert.rejects(
      recordSecurityDeposit({
        orgId: org.orgId, actorId, leaseId, occurredOn: org.date, kind: "received", amount: "100",
      }),
      /An open GL period is required/,
      "a deposit into a user-closed period must be refused",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("deposit recording refuses a source-owned imported lock", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const leaseId = await seedDepositLease(org, "imported");
    await closeAllImported(org);
    await assert.rejects(
      recordSecurityDeposit({
        orgId: org.orgId, actorId, leaseId, occurredOn: org.date, kind: "received", amount: "100",
      }),
      /An open GL period is required/,
      "a deposit into an imported lock must be refused: it is new activity, not replay",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("deposit reversal refuses a user-closed period", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const leaseId = await seedDepositLease(org, "rev-user");
    const recorded = await recordSecurityDeposit({
      orgId: org.orgId, actorId, leaseId, occurredOn: org.date, kind: "received", amount: "100",
    });
    await closeGlForUser(org, actorId);
    await assert.rejects(
      reverseSecurityDepositTransaction({
        orgId: org.orgId, actorId, transactionId: recorded.id,
        occurredOn: org.date, reason: "Gate probe reversal of a closed-period deposit",
      }),
      /An open GL period is required for the reversal date/,
      "a deposit reversal into a user-closed period must be refused",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("deposit reversal refuses a source-owned imported lock", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const leaseId = await seedDepositLease(org, "rev-imported");
    const recorded = await recordSecurityDeposit({
      orgId: org.orgId, actorId, leaseId, occurredOn: org.date, kind: "received", amount: "100",
    });
    await closeAllImported(org);
    await assert.rejects(
      reverseSecurityDepositTransaction({
        orgId: org.orgId, actorId, transactionId: recorded.id,
        occurredOn: org.date, reason: "Gate probe reversal into an imported lock",
      }),
      /An open GL period is required for the reversal date/,
      "a deposit reversal into an imported lock must be refused: reversals are not replay",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

interface CamGateFixture {
  org: ScratchOrg;
  propertyId: string;
  ledgerAccount: string;
}

async function seedCamFixture(): Promise<CamGateFixture> {
  const org = await createScratchOrg();
  await enableProperty(org);
  const propertyId = randomUUID();
  await db.execute(sql`
    insert into managed_properties
      (id, org_id, subsidiary_id, location_id, code, name, property_type, status, currency,
       rent_income_account_id, cam_income_account_id)
    values (${propertyId}, ${org.orgId}, ${org.subsidiaryId}, ${org.locationId}, 'PRP-F2-CAM',
            'Gate CAM Tower', 'commercial', 'active', 'CAD',
            ${org.accounts.revenue}, ${org.accounts.revenue})`);
  await db.execute(sql`
    insert into property_leases
      (id, org_id, property_id, tenant_id, lease_number, status, starts_on, ends_on,
       cam_method, cam_share_percent)
    values (${randomUUID()}, ${org.orgId}, ${propertyId}, ${org.customerId}, 'LSE-F2-CAM',
            'active', '2026-07-01', '2026-07-31', 'pro_rata', '100')`);
  return { org, propertyId, ledgerAccount: org.accounts.adjustment };
}

async function postCamExpense(fixture: CamGateFixture, amount: string): Promise<void> {
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

async function createJulyPool(fixture: CamGateFixture, actorId: string, tag: string): Promise<string> {
  const created = await createCamPool({
    orgId: fixture.org.orgId, actorId, propertyId: fixture.propertyId,
    name: `CAM gate ${tag}`, fiscalYear: 2026, periodStartsOn: "2026-07-01", periodEndsOn: "2026-07-31",
    allocationBasis: "equal", budgetAmount: "1000", expenseAccountIds: [fixture.ledgerAccount],
  });
  return created.id;
}

test("CAM finalization refuses while the period is still open", { skip: !DB }, async () => {
  const fixture = await seedCamFixture();
  try {
    const actorId = (await seedFlowActors(fixture.org.orgId)).adminId;
    await postCamExpense(fixture, "1000");
    const poolId = await createJulyPool(fixture, actorId, "open");
    await assert.rejects(
      finalizeCamPool(fixture.org.orgId, actorId, poolId),
      /Close the GL module for .* before finalizing CAM actuals/,
      "finalizing over an open period must be refused",
    );
  } finally {
    await dropScratchOrg(fixture.org.orgId);
  }
});

test("CAM finalization proceeds once a user closes the period", { skip: !DB }, async () => {
  const fixture = await seedCamFixture();
  try {
    const actorId = (await seedFlowActors(fixture.org.orgId)).adminId;
    await postCamExpense(fixture, "1000");
    const poolId = await createJulyPool(fixture, actorId, "user");
    await closeGlForUser(fixture.org, actorId);
    const result = await finalizeCamPool(fixture.org.orgId, actorId, poolId);
    assert.equal(result.actualAmount, "1000.0000");
  } finally {
    await dropScratchOrg(fixture.org.orgId);
  }
});

test("CAM finalization treats a source-owned imported lock as closed", { skip: !DB }, async () => {
  const fixture = await seedCamFixture();
  try {
    const actorId = (await seedFlowActors(fixture.org.orgId)).adminId;
    await postCamExpense(fixture, "1000");
    const poolId = await createJulyPool(fixture, actorId, "imported");
    await closeAllImported(fixture.org);
    // The inverted gate only observes closure — it never posts into the
    // period — so an imported lock satisfies it exactly like a user lock.
    const result = await finalizeCamPool(fixture.org.orgId, actorId, poolId);
    assert.equal(result.actualAmount, "1000.0000");
  } finally {
    await dropScratchOrg(fixture.org.orgId);
  }
});
