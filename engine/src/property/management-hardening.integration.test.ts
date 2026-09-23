import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool } from "../platform/db.ts";
import {
  PropertyManagementError,
  activatePropertyLease,
  addLeaseCharge,
  addLeaseEscalation,
  applyLeaseEscalation,
  billDueLeaseCharges,
  createCamPool,
  createPropertyLease,
  finalizeCamPool,
  recordSecurityDeposit,
  reopenFinalizedCamPool,
  scheduleLeaseCharges,
  terminatePropertyLease,
  updatePropertyLease,
} from "./management.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";

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

test("R8: lease, charge, and escalation creation refuse invalid policy as domain errors and persist nothing", { skip: !DB }, async () => {
  const fx = await seedProperty();
  try {
    const orgId = fx.org.orgId;
    const leaseId = await activeLease(fx, "L-R8", "2026-01-01", "2026-12-31");
    const counts = async () => (await db.execute<{ leases: number; charges: number; escalations: number }>(sql`
      select (select count(*)::int from property_leases where org_id = ${orgId}) as leases,
        (select count(*)::int from lease_charges where org_id = ${orgId}) as charges,
        (select count(*)::int from lease_escalations where org_id = ${orgId}) as escalations`)).rows[0]!;
    const before = await counts();
    const domain = (error: unknown) => error instanceof PropertyManagementError;
    // Every rejection below used to arrive as a raw storage error (or, for
    // unknown enums, a miscomputed posting); each must now fail closed
    // before writing.
    await assert.rejects(() => createPropertyLease({
      orgId, actorId: fx.actorId, propertyId: fx.propertyId, tenantId: fx.org.customerId,
      leaseNumber: "L-R8-BAD", startsOn: "2026-01-01", endsOn: "2026-12-31", baseRent: "1000",
      billingDay: 99, paymentTermsDays: 0, securityDepositRequired: "0", camMethod: "none",
      lateFeeType: "none", lateFeeValue: "0", graceDays: 0, autoInvoice: true, autoPost: false,
    }), domain, "billing day 99 is refused");
    await assert.rejects(() => addLeaseCharge({
      orgId, actorId: fx.actorId, leaseId, chargeType: "other", description: "Extra",
      amount: "10", frequency: "monthly", effectiveFrom: "not-a-date",
    }), domain, "an invalid charge date is refused");
    await assert.rejects(() => addLeaseCharge({
      orgId, actorId: fx.actorId, leaseId, chargeType: "other", description: "Extra",
      amount: "10", frequency: "monthly", effectiveFrom: "2026-05-01", effectiveTo: "2026-04-01",
    }), domain, "an inverted charge window is refused");
    await assert.rejects(() => addLeaseEscalation({
      orgId, actorId: fx.actorId, leaseId, effectiveOn: "2026-07-01", method: "bogus" as never, value: "50",
    }), domain, "an unknown escalation method is refused");
    assert.deepEqual(await counts(), before, "no refused creation persisted a row");
    // A none late fee carries no value: creation coerces it exactly like an
    // update instead of tripping the storage guard.
    const coerced = await createPropertyLease({
      orgId, actorId: fx.actorId, propertyId: fx.propertyId, tenantId: fx.org.customerId,
      leaseNumber: "L-R8-NONE", startsOn: "2026-01-01", endsOn: "2026-12-31", baseRent: "1000",
      billingDay: 1, paymentTermsDays: 0, securityDepositRequired: "0", camMethod: "none",
      lateFeeType: "none", lateFeeValue: "50", graceDays: 0, autoInvoice: true, autoPost: false,
    });
    const stored = (await db.execute<{ late_fee_value: string }>(sql`
      select late_fee_value::text from property_leases where org_id = ${orgId} and id = ${coerced.id}`)).rows[0]!;
    assert.equal(stored.late_fee_value, "0.0000");
  } finally {
    await dropScratchOrg(fx.org.orgId);
  }
});

test("R9: a retried deposit import key is refused as a domain error without posting twice", { skip: !DB }, async () => {
  const fx = await seedProperty();
  try {
    const orgId = fx.org.orgId;
    const leaseId = await activeLease(fx, "L-IMP", "2026-01-01", null);
    const entries = async () => (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from journal_entries where org_id = ${orgId}`)).rows[0]!.n;
    const journalsBefore = await entries();
    const first = await recordSecurityDeposit({
      orgId, actorId: fx.actorId, leaseId, kind: "received",
      occurredOn: fx.org.date, amount: "500", importKey: "imp-dup-1",
    });
    assert.equal(first.balance, "500.0000");
    await assert.rejects(
      () => recordSecurityDeposit({
        orgId, actorId: fx.actorId, leaseId, kind: "received",
        occurredOn: fx.org.date, amount: "500", importKey: "imp-dup-1",
      }),
      (error: unknown) => error instanceof PropertyManagementError && /already imported/.test(error.message),
    );
    const ledger = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from security_deposit_transactions where org_id = ${orgId} and lease_id = ${leaseId}`)).rows[0]!;
    assert.equal(ledger.n, 1, "the retried import posted nothing");
    assert.equal(await entries(), journalsBefore + 1, "the retried import left no extra journal");
  } finally {
    await dropScratchOrg(fx.org.orgId);
  }
});

test("R10: concurrent duplicate deposit imports on different leases map to a domain error", { skip: !DB }, async () => {
  const fx = await seedProperty();
  const writer = await pool.connect();
  let pending: Promise<{ status: "fulfilled"; value: { id: string }; } | { status: "rejected"; reason: unknown }> | undefined;
  try {
    const orgId = fx.org.orgId;
    const leaseA = await activeLease(fx, "L-RACE-A", "2026-01-01", null);
    const leaseB = await activeLease(fx, "L-RACE-B", "2026-01-01", null);
    // A racing import on another lease: uncommitted, so the lease-scoped
    // preflight cannot see it and only the storage backstop can refuse it.
    await writer.query("begin");
    await writer.query("select set_config('app.bypass_rls','on',true)");
    const seedEntryId = randomUUID();
    await writer.query(
      `insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
       values ($1, $2, $3, $4, $5, $6, $7, 'race seed', 'draft', 'manual')`,
      [seedEntryId, orgId, fx.org.bookId, fx.org.subsidiaryId, `RACE-${seedEntryId.slice(0, 8)}`, fx.org.date, fx.org.periodId],
    );
    await writer.query(
      `insert into security_deposit_transactions (org_id, lease_id, kind, occurred_on, amount, bank_account_id, journal_entry_id, import_key)
       values ($1, $2, 'received', $3, 500, $4, $5, 'race-dup-1')`,
      [orgId, leaseA, fx.org.date, fx.org.accounts.bank, seedEntryId],
    );
    const writerPid = (await writer.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    pending = recordSecurityDeposit({
      orgId, actorId: fx.actorId, leaseId: leaseB, kind: "received",
      occurredOn: fx.org.date, amount: "500", importKey: "race-dup-1",
    }).then(
      (value) => ({ status: "fulfilled" as const, value: { id: value.id } }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    let blocked = false;
    for (let attempt = 0; attempt < 400; attempt++) {
      const count = (await pool.query<{ n: number }>(
        "select count(*)::int as n from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))", [writerPid])).rows[0]!.n;
      if (count) { blocked = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(blocked, "the duplicate import must wait for the racing import");
    await writer.query("commit");
    const result = await pending;
    assert.equal(result.status, "rejected");
    if (result.status !== "rejected") assert.fail("a racing duplicate import must be refused");
    assert.ok(result.reason instanceof PropertyManagementError && /already imported/.test(result.reason.message),
      "the storage conflict maps to a domain error, not a raw unique violation");
  } finally {
    await writer.query("rollback");
    writer.release();
    await pending;
    await dropScratchOrg(fx.org.orgId);
  }
});

test("R11: duplicate lease/escalation identities and invalid charge references fail closed without persisting", { skip: !DB }, async () => {
  const fx = await seedProperty();
  try {
    const orgId = fx.org.orgId;
    const leaseId = await activeLease(fx, "L-R11", "2026-01-01", "2026-12-31");
    const counts = async () => (await db.execute<{ leases: number; charges: number; escalations: number }>(sql`
      select (select count(*)::int from property_leases where org_id = ${orgId}) as leases,
        (select count(*)::int from lease_charges where org_id = ${orgId}) as charges,
        (select count(*)::int from lease_escalations where org_id = ${orgId}) as escalations`)).rows[0]!;
    const before = await counts();
    const domain = (error: unknown) => error instanceof PropertyManagementError;
    // Duplicate identities used to arrive as raw unique violations.
    await assert.rejects(() => createPropertyLease({
      orgId, actorId: fx.actorId, propertyId: fx.propertyId, tenantId: fx.org.customerId,
      leaseNumber: "L-R11", startsOn: "2026-01-01", endsOn: "2026-12-31", baseRent: "1000",
      billingDay: 1, paymentTermsDays: 0, securityDepositRequired: "0", camMethod: "none",
      lateFeeType: "none", lateFeeValue: "0", graceDays: 0, autoInvoice: true, autoPost: false,
    }), domain, "a duplicate lease number is refused");
    const draft = await createPropertyLease({
      orgId, actorId: fx.actorId, propertyId: fx.propertyId, tenantId: fx.org.customerId,
      leaseNumber: "L-R11-DRAFT", startsOn: "2026-01-01", endsOn: "2026-12-31", baseRent: "1000",
      billingDay: 1, paymentTermsDays: 0, securityDepositRequired: "0", camMethod: "none",
      lateFeeType: "none", lateFeeValue: "0", graceDays: 0, autoInvoice: true, autoPost: false,
    });
    await assert.rejects(() => updatePropertyLease({
      orgId, actorId: fx.actorId, leaseId: draft.id, propertyId: fx.propertyId, tenantId: fx.org.customerId,
      leaseNumber: "L-R11", startsOn: "2026-01-01", endsOn: "2026-12-31", baseRent: "1000",
      billingDay: 1, paymentTermsDays: 0, securityDepositRequired: "0", camMethod: "none",
      lateFeeType: "none", lateFeeValue: "0", graceDays: 0, autoInvoice: true, autoPost: false,
    }), domain, "renaming onto a duplicate lease number is refused");
    await addLeaseEscalation({
      orgId, actorId: fx.actorId, leaseId, effectiveOn: "2026-07-01", method: "percent", value: "5",
    });
    await assert.rejects(() => addLeaseEscalation({
      orgId, actorId: fx.actorId, leaseId, effectiveOn: "2026-07-01", method: "fixed", value: "10",
    }), domain, "a duplicate escalation date is refused");
    // Charge references used to arrive as raw foreign-key or invalid-text
    // errors at commit; the deferrable FKs stay as the race backstop.
    const bogus = randomUUID();
    for (const [label, ref] of [
      ["an unknown income account", { incomeAccountId: bogus }],
      ["a malformed income account", { incomeAccountId: "not-a-uuid" }],
      ["a bank account as income", { incomeAccountId: fx.org.accounts.bank }],
      ["an unknown item", { itemId: bogus }],
      ["an unknown tax code", { taxCodeId: bogus }],
    ] as const) {
      await assert.rejects(() => addLeaseCharge({
        orgId, actorId: fx.actorId, leaseId, chargeType: "other", description: "Extra",
        amount: "10", frequency: "monthly", effectiveFrom: "2026-05-01", ...ref,
      }), domain, `a charge with ${label} is refused`);
    }
    // The guards must not over-reject: a fully-referenced charge commits.
    const valid = await addLeaseCharge({
      orgId, actorId: fx.actorId, leaseId, chargeType: "other", description: "Valid extra",
      amount: "10", frequency: "monthly", effectiveFrom: "2026-05-01",
      incomeAccountId: fx.org.accounts.revenue, itemId: fx.org.items.service,
    });
    assert.ok(valid.id);
    const after = await counts();
    assert.deepEqual(
      { leases: after.leases - before.leases, charges: after.charges - before.charges, escalations: after.escalations - before.escalations },
      { leases: 1, charges: 2, escalations: 1 },
      "only the valid draft lease with its base rent, the valid charge, and the first escalation persisted",
    );
  } finally {
    await dropScratchOrg(fx.org.orgId);
  }
});
test("R13: CAM finalization refuses an overlapping lease with no rentable area instead of shifting its share", async () => {
  const fx = await seedProperty();
  try {
    const orgId = fx.org.orgId;
    const unitA = randomUUID();
    await db.execute(sql`
      insert into property_units (id, org_id, property_id, code, rentable_area, status)
      values (${unitA}, ${orgId}, ${fx.propertyId}, 'UA', 100, 'occupied')`);
    const leaseA = randomUUID();
    const leaseB = randomUUID();
    await db.execute(sql`
      insert into property_leases (id, org_id, property_id, unit_id, tenant_id, lease_number, status, starts_on, ends_on, cam_method)
      values (${leaseA}, ${orgId}, ${fx.propertyId}, ${unitA}, ${fx.org.customerId}, 'LSE-CAM-AREA', 'active', '2026-07-01', '2026-07-31', 'pro_rata'),
             (${leaseB}, ${orgId}, ${fx.propertyId}, null, ${fx.org.customerId}, 'LSE-CAM-NOAREA', 'active', '2026-07-01', '2026-07-31', 'pro_rata')`);
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
      orgId, actorId: fx.actorId, propertyId: fx.propertyId, name: "FY26 AREA", fiscalYear: 2026,
      periodStartsOn: "2026-07-01", periodEndsOn: "2026-07-31", allocationBasis: "rentable_area", budgetAmount: "10000",
      expenseAccountIds: [fx.org.accounts.adjustment],
    });
    // The area-less lease used to vanish from the weights, billing lease A
    // 100% of the pool. Finalization must refuse and name it instead.
    await assert.rejects(
      finalizeCamPool(orgId, fx.actorId, pool.id),
      (error: unknown) => error instanceof PropertyManagementError
        && /LSE-CAM-NOAREA/.test(error.message)
        && /rentable area/.test(error.message),
    );
    const persisted = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from cam_allocations where org_id = ${orgId} and pool_id = ${pool.id}`)).rows[0]!.n;
    assert.equal(persisted, 0, "the refused finalization persisted no allocations");
    const status = (await db.execute<{ status: string }>(sql`
      select status from cam_pools where org_id = ${orgId} and id = ${pool.id}`)).rows[0]!.status;
    assert.equal(status, "open", "the refused pool stays open for correction");
    // Give the lease a 300 sqft unit: the pool now prices 100:300 exactly.
    const unitB = randomUUID();
    await db.execute(sql`
      insert into property_units (id, org_id, property_id, code, rentable_area, status)
      values (${unitB}, ${orgId}, ${fx.propertyId}, 'UB', 300, 'occupied')`);
    await db.execute(sql`update property_leases set unit_id = ${unitB} where org_id = ${orgId} and id = ${leaseB}`);
    const finalized = await finalizeCamPool(orgId, fx.actorId, pool.id);
    assert.equal(finalized.allocations, 2);
    const shares = (await db.execute<{ lease_number: string; share_percent: string; actual_allocation: string }>(sql`
      select l.lease_number, a.share_percent::text, a.actual_allocation::text
        from cam_allocations a join property_leases l on l.id = a.lease_id and l.org_id = a.org_id
       where a.org_id = ${orgId} and a.pool_id = ${pool.id} order by l.lease_number`)).rows;
    assert.deepEqual(shares.map((row) => [row.lease_number, row.share_percent, row.actual_allocation]), [
      ["LSE-CAM-AREA", "25.0000", "2500.0000"],
      ["LSE-CAM-NOAREA", "75.0000", "7500.0000"],
    ]);
  } finally {
    await dropScratchOrg(fx.org.orgId);
  }
});

test("R14: CAM finalization waits for a concurrent lease-weight edit and seals the committed value", async () => {
  const fx = await seedProperty();
  let holder: { query: (text: string) => Promise<unknown>; release: () => void } | null = null;
  let outcome: Promise<{ actualAmount: string; allocations: number }> | null = null;
  try {
    const orgId = fx.org.orgId;
    const unitA = randomUUID();
    const unitB = randomUUID();
    await db.execute(sql`
      insert into property_units (id, org_id, property_id, code, rentable_area, status)
      values (${unitA}, ${orgId}, ${fx.propertyId}, 'UA', 100, 'occupied'),
             (${unitB}, ${orgId}, ${fx.propertyId}, 'UB', 100, 'occupied')`);
    const leaseA = randomUUID();
    const leaseB = randomUUID();
    await db.execute(sql`
      insert into property_leases (id, org_id, property_id, unit_id, tenant_id, lease_number, status, starts_on, ends_on, cam_method)
      values (${leaseA}, ${orgId}, ${fx.propertyId}, ${unitA}, ${fx.org.customerId}, 'LSE-CAM-WA', 'active', '2026-07-01', '2026-07-31', 'pro_rata'),
             (${leaseB}, ${orgId}, ${fx.propertyId}, ${unitB}, ${fx.org.customerId}, 'LSE-CAM-WB', 'active', '2026-07-01', '2026-07-31', 'pro_rata')`);
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
    const camPool = await createCamPool({
      orgId, actorId: fx.actorId, propertyId: fx.propertyId, name: "FY26 FENCE", fiscalYear: 2026,
      periodStartsOn: "2026-07-01", periodEndsOn: "2026-07-31", allocationBasis: "rentable_area", budgetAmount: "10000",
      expenseAccountIds: [fx.org.accounts.adjustment],
    });
    // A concurrent unit edit holds its row the way updatePropertyUnit does —
    // FOR UPDATE, uncommitted — while finalization starts on another session.
    // A raw pooled client carries no tenant: without app.current_org the RLS
    // policy yields zero rows, the UPDATE locks nothing, and the test would
    // prove nothing. Set the tenant and assert the row count.
    const client = await pool.connect();
    holder = client;
    await client.query("BEGIN");
    await client.query("select set_config('app.current_org', $1, false)", [orgId]);
    const held = await client.query("update property_units set rentable_area = 400 where org_id = $1 and id = $2", [orgId, unitA]);
    assert.equal(held.rowCount, 1, "the holder edit must own the unit row for the whole probe");
    let settled = false;
    let failed: unknown = null;
    outcome = finalizeCamPool(orgId, fx.actorId, camPool.id);
    void outcome.then(() => { settled = true; }, (error: unknown) => { settled = true; failed = error; });
    const deadline = Date.now() + 10_000;
    let blocked = false;
    while (!settled && Date.now() < deadline) {
      // A row-weight waiter parks on the holder's transaction id (no
      // relation attached), so watch waiter state rather than pg_locks.
      blocked = (await db.execute<{ blocked: boolean }>(sql`select exists(
        select 1 from pg_stat_activity
         where datname = current_database() and pid <> pg_backend_pid()
           and state = 'active' and wait_event_type = 'Lock'
      ) as blocked`)).rows[0]!.blocked;
      if (blocked) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(blocked, `finalization must park on the weight lock instead of reading past the edit (early failure: ${String(failed)})`);
    assert.ok(!settled, "finalization must not complete while the weight edit is uncommitted");
    await client.query("COMMIT");
    holder = null;
    await client.query("select set_config('app.current_org', '', false)");
    client.release();
    const finalized = await outcome;
    assert.ifError(failed);
    assert.equal(finalized.allocations, 2);
    const shares = (await db.execute<{ lease_number: string; share_percent: string }>(sql`
      select l.lease_number, a.share_percent::text
        from cam_allocations a join property_leases l on l.id = a.lease_id and l.org_id = a.org_id
       where a.org_id = ${orgId} and a.pool_id = ${camPool.id} order by l.lease_number`)).rows;
    assert.deepEqual(shares.map((row) => [row.lease_number, row.share_percent]), [
      ["LSE-CAM-WA", "80.0000"],
      ["LSE-CAM-WB", "20.0000"],
    ], "the sealed allocation reflects the committed 400 sqft edit, never the stale 100");
  } finally {
    if (holder) {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.query("select set_config('app.current_org', '', false)").catch(() => {});
      holder.release();
    }
    await dropScratchOrg(fx.org.orgId);
  }
});


test("R12: a blank termination date is refused without mutating the lease", { skip: !DB }, async () => {
  const fx = await seedProperty();
  try {
    const orgId = fx.org.orgId;
    const leaseId = await activeLease(fx, "L-R12", "2026-01-01", "2026-12-31");
    // A blank date previously terminated the lease with a null move-out date.
    await assert.rejects(
      () => terminatePropertyLease(orgId, fx.actorId, leaseId, "", "Tenant left"),
      (error: unknown) => error instanceof PropertyManagementError && /Termination date is required/.test(error.message),
    );
    const row = (await db.execute<{ status: string; endsOn: string | null; moveOutOn: string | null; scheduled: number }>(sql`
      select l.status, l.ends_on::text as "endsOn", l.move_out_on::text as "moveOutOn",
        (select count(*)::int from lease_schedule_lines where org_id = l.org_id and lease_id = l.id and status = 'scheduled') as scheduled
        from property_leases l where l.org_id = ${orgId} and l.id = ${leaseId}`)).rows[0]!;
    assert.deepEqual(
      { status: row.status, endsOn: row.endsOn, moveOutOn: row.moveOutOn },
      { status: "active", endsOn: "2026-12-31", moveOutOn: null },
      "the refused termination changed nothing",
    );
    assert.ok(row.scheduled > 0, "earned schedules survive the refused termination");
  } finally {
    await dropScratchOrg(fx.org.orgId);
  }
});
