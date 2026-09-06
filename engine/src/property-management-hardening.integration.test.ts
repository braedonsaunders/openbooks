import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  PropertyManagementError,
  activatePropertyLease,
  addLeaseEscalation,
  applyLeaseEscalation,
  billDueLeaseCharges,
  createCamPool,
  createPropertyLease,
  finalizeCamPool,
  recordSecurityDeposit,
  reopenFinalizedCamPool,
  scheduleLeaseCharges,
  updatePropertyLease,
} from "./property-management.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

interface Fixture {
  org: ScratchOrg;
  actorId: string;
  propertyId: string;
}

/** Property-management org with one active, fully configured property whose tenant is an active customer. */
async function seedProperty(): Promise<Fixture> {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Property operator", "admin");
  await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{features}',
      coalesce(settings->'features','{}'::jsonb) || '{"propertyManagement": true}'::jsonb)
     where id = ${org.orgId}`);
  await db.execute(sql`
    insert into customer_roles (org_id, party_id, ar_account_id, credit_limit, currency, is_on_hold, created_by, updated_by)
    values (${org.orgId}, ${org.customerId}, ${org.accounts.ar}, '0', 'CAD', false, ${actorId}, ${actorId})`);
  const propertyId = randomUUID();
  await db.execute(sql`
    insert into managed_properties
      (id, org_id, subsidiary_id, location_id, code, name, property_type, status, currency,
       rent_income_account_id, cam_income_account_id, deposit_liability_account_id, default_bank_account_id)
    values (${propertyId}, ${org.orgId}, ${org.subsidiaryId}, ${org.locationId}, 'PRP-HARD',
            'Hardening Tower', 'commercial', 'active', 'CAD',
            ${org.accounts.revenue}, ${org.accounts.revenue}, ${org.accounts.deferred}, ${org.accounts.bank})`);
  return { org, actorId, propertyId };
}

const leaseTerms = {
  billingDay: 1, paymentTermsDays: 0, securityDepositRequired: "0", camMethod: "none" as const,
  lateFeeType: "none" as const, lateFeeValue: "0", graceDays: 0, autoInvoice: true, autoPost: false,
};

async function activeLease(fx: Fixture, leaseNumber: string, startsOn: string, endsOn: string | null): Promise<string> {
  const lease = await createPropertyLease({
    orgId: fx.org.orgId, actorId: fx.actorId, propertyId: fx.propertyId, tenantId: fx.org.customerId,
    leaseNumber, startsOn, endsOn, baseRent: "1000", ...leaseTerms,
  });
  await activatePropertyLease(fx.org.orgId, fx.actorId, lease.id);
  return lease.id;
}

const scheduleCount = (orgId: string, leaseId: string, fromInclusive: string) => db.execute<{ n: number }>(sql`
  select count(*)::int as n from lease_schedule_lines
   where org_id = ${orgId} and lease_id = ${leaseId} and status = 'scheduled' and period_starts_on >= ${fromInclusive}`)
  .then((r) => r.rows[0]!.n);

const isDomainError = (pattern: RegExp) => (error: unknown) =>
  error instanceof PropertyManagementError && pattern.test(error.message);

test("R2: extending an active lease term extends its base-rent window and the extended term schedules and escalates", { skip: !DB }, async () => {
  const fx = await seedProperty();
  try {
    const orgId = fx.org.orgId;
    const leaseId = await activeLease(fx, "L-EXT", "2026-01-01", "2026-12-31");
    assert.equal(await scheduleCount(orgId, leaseId, "2027-01-01"), 0);

    await updatePropertyLease({
      orgId, actorId: fx.actorId, leaseId, propertyId: fx.propertyId, tenantId: fx.org.customerId,
      leaseNumber: "L-EXT", startsOn: "2026-01-01", endsOn: "2027-12-31", baseRent: "1000", ...leaseTerms,
      requestId: `extend-${randomUUID()}`,
    });

    const windows = (await db.execute<{ effective_from: string; effective_to: string | null }>(sql`
      select effective_from::text, effective_to::text from lease_charges
       where org_id = ${orgId} and lease_id = ${leaseId} and charge_type = 'base_rent' order by effective_from`)).rows;
    assert.deepEqual(windows, [{ effective_from: "2026-01-01", effective_to: "2027-12-31" }],
      "the term-derived base-rent window follows the extended lease end");

    // The extension is audited on the charge row it changed, inside the same write.
    const chargeAudit = (await db.execute<{ changes: { before?: { effectiveTo?: string }; after?: { effectiveTo?: string } } }>(sql`
      select a.changes from audit_log a join lease_charges c on c.id = a.row_id and c.org_id = a.org_id
       where a.org_id = ${orgId} and a.table_name = 'lease_charges' and a.action = 'update' and c.lease_id = ${leaseId}`)).rows;
    assert.equal(chargeAudit.length, 1, "base-rent window extension leaves audit evidence");
    assert.equal(chargeAudit[0]!.changes.before?.effectiveTo, "2026-12-31");
    assert.equal(chargeAudit[0]!.changes.after?.effectiveTo, "2027-12-31");

    const scheduled = await scheduleLeaseCharges(orgId, fx.actorId, leaseId, "2027-12-31");
    assert.equal(scheduled.created, 12, "twelve new monthly periods for the extended year");
    assert.equal(await scheduleCount(orgId, leaseId, "2027-01-01"), 12);

    // A rent escalation inside the extended term now finds its effective charge.
    const escalation = await addLeaseEscalation({ orgId, actorId: fx.actorId, leaseId, effectiveOn: "2027-01-01", method: "percent", value: "10" });
    const applied = await applyLeaseEscalation(orgId, fx.actorId, escalation.id);
    assert.equal(applied.newAmount, "1100.0000");
  } finally {
    await dropScratchOrg(fx.org.orgId);
  }
});

test("R3: escalations apply strictly in effective-date order so rent compounds correctly", { skip: !DB }, async () => {
  const fx = await seedProperty();
  try {
    const orgId = fx.org.orgId;
    const leaseId = await activeLease(fx, "L-ESC", "2026-01-01", null);
    const input = { orgId, actorId: fx.actorId, leaseId, method: "percent" as const, value: "10" };
    const a = await addLeaseEscalation({ ...input, effectiveOn: "2026-07-01" });
    const b = await addLeaseEscalation({ ...input, effectiveOn: "2027-01-01" });

    // Out of order: the later one cannot jump the earlier scheduled one.
    await assert.rejects(() => applyLeaseEscalation(orgId, fx.actorId, b.id), isDomainError(/2026-07-01/));
    const untouched = (await db.execute<{ status: string; new_amount: string | null }>(sql`
      select status, new_amount::text from lease_escalations where org_id = ${orgId} and id = ${b.id}`)).rows[0]!;
    assert.deepEqual(untouched, { status: "scheduled", new_amount: null });

    // In order: 1000 -> 1100 -> 1210.
    assert.equal((await applyLeaseEscalation(orgId, fx.actorId, a.id)).newAmount, "1100.0000");
    assert.equal((await applyLeaseEscalation(orgId, fx.actorId, b.id)).newAmount, "1210.0000");
    const windows = (await db.execute<{ effective_from: string; amount: string }>(sql`
      select effective_from::text, amount::text from lease_charges
       where org_id = ${orgId} and lease_id = ${leaseId} and charge_type = 'base_rent' order by effective_from`)).rows;
    assert.deepEqual(windows, [
      { effective_from: "2026-01-01", amount: "1000.0000" },
      { effective_from: "2026-07-01", amount: "1100.0000" },
      { effective_from: "2027-01-01", amount: "1210.0000" },
    ]);

    // Defense in depth: a later escalation that is already applied (however it
    // got there) blocks an earlier-dated apply that would silently under-compound.
    const c = await addLeaseEscalation({ ...input, effectiveOn: "2028-01-01" });
    await db.execute(sql`update lease_escalations set status='applied', applied_at=now() where org_id = ${orgId} and id = ${c.id}`);
    const d = await addLeaseEscalation({ ...input, effectiveOn: "2027-06-01" });
    await assert.rejects(() => applyLeaseEscalation(orgId, fx.actorId, d.id), isDomainError(/2028-01-01/));
  } finally {
    await dropScratchOrg(fx.org.orgId);
  }
});

test("R5: schedule horizon and billing date are validated and bounded", { skip: !DB }, async () => {
  const fx = await seedProperty();
  try {
    const orgId = fx.org.orgId;
    const leaseId = await activeLease(fx, "L-HOR", "2026-01-01", null);
    const before = await scheduleCount(orgId, leaseId, "0001-01-01");

    await assert.rejects(() => scheduleLeaseCharges(orgId, fx.actorId, leaseId, "2200-12-31"), isDomainError(/horizon/i));
    await assert.rejects(() => scheduleLeaseCharges(orgId, fx.actorId, leaseId, "1999-13-45"), isDomainError(/invalid/i));
    await assert.rejects(() => scheduleLeaseCharges(orgId, fx.actorId, leaseId, "2026-2-1"), isDomainError(/invalid/i));
    assert.equal(await scheduleCount(orgId, leaseId, "0001-01-01"), before, "refused horizons create nothing");

    await assert.rejects(() => billDueLeaseCharges(orgId, fx.actorId, "not-a-date"), isDomainError(/invalid/i));
    await assert.rejects(() => billDueLeaseCharges(orgId, fx.actorId, "2026-02-30"), isDomainError(/invalid/i));
  } finally {
    await dropScratchOrg(fx.org.orgId);
  }
});

test("R6: security-deposit offset accounts are validated against the liability, controls, cash, and inactive accounts", { skip: !DB }, async () => {
  const fx = await seedProperty();
  try {
    const orgId = fx.org.orgId;
    const leaseId = await activeLease(fx, "L-DEP", "2026-01-01", null);
    const base = { orgId, actorId: fx.actorId, leaseId, occurredOn: fx.org.date };
    await recordSecurityDeposit({ ...base, kind: "received", amount: "5000" });

    const inactive = randomUUID();
    await db.execute(sql`insert into accounts (id, org_id, number, name, type, is_active) values (${inactive}, ${orgId}, '5900', 'Retired expense', 'expense', false)`);
    const summary = randomUUID();
    await db.execute(sql`insert into accounts (id, org_id, number, name, type, is_summary) values (${summary}, ${orgId}, '5000S', 'Expenses (summary)', 'expense', true)`);

    for (const [label, offsetAccountId] of [
      ["the deposit liability itself", fx.org.accounts.deferred],
      ["an AR control account", fx.org.accounts.ar],
      ["an AP control account", fx.org.accounts.ap],
      ["a bank account", fx.org.accounts.bank],
      ["an inactive account", inactive],
      ["a summary account", summary],
      ["an unknown account", randomUUID()],
    ] as const) {
      await assert.rejects(
        () => recordSecurityDeposit({ ...base, kind: "interest", amount: "10", offsetAccountId }),
        (error: unknown) => error instanceof PropertyManagementError,
        `interest against ${label} is refused`,
      );
    }
    // Cash movements post against the bank account: a caller-supplied offset
    // cannot redirect the cash leg while the subledger records the bank.
    await assert.rejects(
      () => recordSecurityDeposit({ ...base, kind: "refunded", amount: "100", offsetAccountId: fx.org.accounts.adjustment }),
      (error: unknown) => error instanceof PropertyManagementError,
    );

    const ledger = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from security_deposit_transactions where org_id = ${orgId} and lease_id = ${leaseId}`)).rows[0]!;
    assert.equal(ledger.n, 1, "no refused posting reached the subledger");

    const ok = await recordSecurityDeposit({ ...base, kind: "interest", amount: "10", offsetAccountId: fx.org.accounts.adjustment });
    assert.equal(ok.balance, "5010.0000");
  } finally {
    await dropScratchOrg(fx.org.orgId);
  }
});

test("R7: CAM allocation residual and fingerprint are deterministic across physical row order", { skip: !DB }, async () => {
  const fx = await seedProperty();
  try {
    const orgId = fx.org.orgId;
    // Three equal-weight tenants inserted in ascending id order, so physical
    // (TID) order and id order agree until the rows are relocated below.
    const leaseIds = [randomUUID(), randomUUID(), randomUUID()].sort();
    const insertLease = (id: string) => db.execute(sql`
      insert into property_leases (id, org_id, property_id, tenant_id, lease_number, status, starts_on, ends_on, cam_method, cam_share_percent)
      values (${id}, ${orgId}, ${fx.propertyId}, ${fx.org.customerId}, ${`LSE-CAM-${id.slice(0, 8)}`}, 'active', '2026-07-01', '2026-07-31', 'pro_rata', '100')`);
    for (const id of leaseIds) await insertLease(id);
    const entryId = randomUUID();
    await db.execute(sql`
      insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
      values (${entryId}, ${orgId}, ${fx.org.bookId}, ${fx.org.subsidiaryId}, ${`CAM-${entryId.slice(0, 8)}`}, '2026-07-15', ${fx.org.periodId}, 'CAM source', 'draft', 'manual')`);
    await db.execute(sql`
      insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, location_id, amount, currency, txn_amount, fx_rate)
      values (${orgId}, ${entryId}, 1, ${fx.org.accounts.adjustment}, ${fx.org.subsidiaryId}, ${fx.org.locationId}, 10000, 'CAD', 10000, 1),
             (${orgId}, ${entryId}, 2, ${fx.org.accounts.bank}, ${fx.org.subsidiaryId}, null, -10000, 'CAD', -10000, 1)`);
    await db.execute(sql`update journal_entries set status='posted', posted_at=now() where org_id = ${orgId} and id = ${entryId}`);
    await db.execute(sql`
      insert into period_locks (org_id, period_id, book_id, subsidiary_id, module, state, locked_at, locked_by, reason, created_by, updated_by)
      values (${orgId}, ${fx.org.periodId}, ${fx.org.bookId}, ${fx.org.subsidiaryId}, 'gl', 'closed', now(), ${fx.actorId}, 'CAM', ${fx.actorId}, ${fx.actorId})`);
    const pool = await createCamPool({
      orgId, actorId: fx.actorId, propertyId: fx.propertyId, name: "FY26 THIRDS", fiscalYear: 2026,
      periodStartsOn: "2026-07-01", periodEndsOn: "2026-07-31", allocationBasis: "equal", budgetAmount: "10000",
      expenseAccountIds: [fx.org.accounts.adjustment],
    });

    const snapshot = async () => {
      const rows = (await db.execute<{ lease_id: string; share_percent: string; actual_allocation: string; budget_allocation: string }>(sql`
        select lease_id::text, share_percent::text, actual_allocation::text, budget_allocation::text
          from cam_allocations where org_id = ${orgId} and pool_id = ${pool.id} order by lease_id`)).rows;
      const fingerprint = (await db.execute<{ fp: string }>(sql`
        select changes->>'sourceFingerprint' as fp from audit_log
         where org_id = ${orgId} and table_name = 'cam_pools' and row_id = ${pool.id} and action = 'finalize'
         order by at desc, id desc limit 1`)).rows[0]!.fp;
      return { rows, fingerprint };
    };

    await finalizeCamPool(orgId, fx.actorId, pool.id);
    const first = await snapshot();
    assert.equal(first.rows.length, 3);
    const residualHolder = first.rows.find((row) => row.actual_allocation === "3333.3400");
    assert.ok(residualHolder, "one tenant carries the rounding residual");

    // Relocate the two lower-id leases physically (what a restore, repack, or
    // VACUUM FULL does): identical sources, different heap/TID order. A
    // physical-order-dependent allocation would now move the residual.
    await reopenFinalizedCamPool(orgId, fx.actorId, pool.id, "determinism check");
    for (const id of leaseIds.slice(0, 2)) {
      await db.execute(sql`delete from property_leases where org_id = ${orgId} and id = ${id}`);
      await insertLease(id);
    }
    await finalizeCamPool(orgId, fx.actorId, pool.id);
    const second = await snapshot();
    assert.deepEqual(second.rows, first.rows, "allocations are a pure function of the sources");
    assert.equal(second.fingerprint, first.fingerprint, "fingerprint is independent of row order");
    // Documented convention: the largest weight absorbs the residual, ties to the lowest lease id.
    assert.equal(residualHolder.lease_id, leaseIds[0], "equal weights: the residual lands on the lowest lease id");
  } finally {
    await dropScratchOrg(fx.org.orgId);
  }
});
