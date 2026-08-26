import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  PropertyManagementError,
  depositBalance,
  depositReversalKind,
  depositPostingShape,
  escalatedRent,
  leaseChargeSchedule,
  overlapDayCount,
  prorateLeaseCharge,
} from "./property-management.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("lease proration uses exact inclusive calendar days", () => {
  assert.equal(prorateLeaseCharge("3100", "2026-01-01", "2026-01-31", "2026-01-16", "2026-01-31"), "1600.0000");
  assert.equal(prorateLeaseCharge("2800", "2026-02-01", "2026-02-28", "2026-02-01", "2026-02-14"), "1400.0000");
  assert.equal(prorateLeaseCharge("100", "2026-01-01", "2026-01-31", "2026-02-01", "2026-02-28"), "0.0000");
});

test("recurring schedules clamp billing day and prorate first and last periods", () => {
  assert.deepEqual(leaseChargeSchedule({
    amount: "3100",
    frequency: "monthly",
    effectiveFrom: "2026-01-16",
    effectiveTo: "2026-03-10",
    leaseStartsOn: "2026-01-01",
    leaseEndsOn: "2026-12-31",
    throughOn: "2026-12-31",
    billingDay: 31,
  }), [
    { periodStartsOn: "2026-01-16", periodEndsOn: "2026-01-31", dueOn: "2026-01-31", amount: "1600.0000" },
    { periodStartsOn: "2026-02-01", periodEndsOn: "2026-02-28", dueOn: "2026-02-28", amount: "3100.0000" },
    { periodStartsOn: "2026-03-01", periodEndsOn: "2026-03-10", dueOn: "2026-03-31", amount: "1000.0000" },
  ]);
  assert.deepEqual(leaseChargeSchedule({
    amount: "250",
    frequency: "one_time",
    effectiveFrom: "2026-05-12",
    leaseStartsOn: "2026-01-01",
    throughOn: "2026-12-31",
    billingDay: 1,
  }), [{ periodStartsOn: "2026-05-12", periodEndsOn: "2026-05-12", dueOn: "2026-05-12", amount: "250.0000" }]);
  assert.throws(
    () => leaseChargeSchedule({
      amount: "2.5e2",
      frequency: "one_time",
      effectiveFrom: "2026-05-12",
      leaseStartsOn: "2026-01-01",
      throughOn: "2026-12-31",
      billingDay: 1,
    }),
    (error: unknown) => error instanceof PropertyManagementError && /Charge amount must be an exact decimal/.test(error.message),
  );
});

test("rent escalations preserve exact ledger precision", () => {
  assert.equal(escalatedRent("2000", "percent", "3.25"), "2065.0000");
  assert.equal(escalatedRent("2000", "fixed", "125"), "2125.0000");
  assert.equal(escalatedRent("2000", "new_amount", "2375"), "2375.0000");
  assert.throws(() => escalatedRent("2000", "new_amount", "0"), PropertyManagementError);
});

test("deposit posting shapes put party-bearing liability and AR on the correct sides", () => {
  for (const kind of ["received", "interest", "adjustment_increase"]) {
    assert.deepEqual(depositPostingShape(kind), { kind, liabilitySide: "credit", offsetSide: "debit", offsetIsArOpenItem: false });
  }
  for (const kind of ["refunded", "adjustment_decrease"]) {
    assert.deepEqual(depositPostingShape(kind), { kind, liabilitySide: "debit", offsetSide: "credit", offsetIsArOpenItem: false });
  }
  assert.deepEqual(depositPostingShape("applied"), { kind: "applied", liabilitySide: "debit", offsetSide: "credit", offsetIsArOpenItem: true });
  assert.throws(() => depositPostingShape("chargeback"), /Unsupported deposit transaction type/);
});

test("deposit corrections reverse the subledger sign without deleting evidence", () => {
  assert.equal(depositReversalKind("received"), "refunded");
  assert.equal(depositReversalKind("refunded"), "received");
  assert.equal(depositReversalKind("interest"), "adjustment_decrease");
  assert.equal(depositReversalKind("adjustment_increase"), "adjustment_decrease");
  assert.equal(depositReversalKind("adjustment_decrease"), "adjustment_increase");
  assert.equal(depositReversalKind("applied"), "adjustment_increase");
  assert.throws(() => depositReversalKind("delete"), /Unsupported deposit transaction type/);
});

test("deposit period-close lookup follows the property's subsidiary", () => {
  const source = readFileSync(
    join(repoRoot, "engine/src/property-management.ts"),
    "utf8",
  );
  assert.match(source, /p\.subsidiary_id,'gl'/);
  assert.doesNotMatch(source, /l\.subsidiary_id,'gl'/);
});

test("deposit balance cannot mistake an unsupported transaction for a decrease", () => {
  assert.equal(depositBalance([
    { kind: "received", amount: "2500" },
    { kind: "interest", amount: "25" },
    { kind: "applied", amount: "300" },
    { kind: "refunded", amount: "1000" },
    { kind: "adjustment_decrease", amount: "25" },
  ]), "1200.0000");
  assert.throws(() => depositBalance([{ kind: "unknown", amount: "10" }]), /Unsupported deposit transaction type/);
});

test("assessLeaseLateFees persists a fixed late-fee value through canonicalDecimal then normalizeMoney", () => {
  const source = readFileSync(
    join(repoRoot, "engine/src/property-management.ts"),
    "utf8",
  );
  const helperStart = source.indexOf("function exactMoney");
  const helperEnd = source.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "exactMoney helper is defined");
  const helper = source.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);

  const start = source.indexOf("export async function assessLeaseLateFees");
  const next = source.indexOf("export async function recordSecurityDeposit");
  const body = source.slice(start, next);
  assert.match(body, /exactMoney\(row\.late_fee_value, "Late-fee value"\)/);
  assert.doesNotMatch(body, /normalizeMoney\(row\.late_fee_value\)/);
});

test("finalizeCamPool persists cam_share_percent through canonicalDecimal then normalizeMoney", () => {
  const source = readFileSync(
    join(repoRoot, "engine/src/property-management.ts"),
    "utf8",
  );
  const helperStart = source.indexOf("function exactMoney");
  const helperEnd = source.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "exactMoney helper is defined");
  const helper = source.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);

  const start = source.indexOf("export async function finalizeCamPool");
  const next = source.indexOf("export async function billCamReconciliation");
  const body = source.slice(start, next);
  assert.match(body, /exactMoney\(lease\.cam_share_percent, "CAM share"\)/);
  assert.doesNotMatch(body, /normalizeMoney\(lease\.cam_share_percent\)/);
});

test("finalizeCamPool persists actualAmount through canonicalDecimal then normalizeMoney", () => {
  const source = readFileSync(
    join(repoRoot, "engine/src/property-management.ts"),
    "utf8",
  );
  const helperStart = source.indexOf("function exactMoney");
  const helperEnd = source.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "exactMoney helper is defined");
  const helper = source.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);

  const start = source.indexOf("export async function finalizeCamPool");
  const next = source.indexOf("export async function billCamReconciliation");
  const body = source.slice(start, next);
  assert.match(body, /exactMoney\(actual\.rows\[0\]\?\.amount \?\? "0", "CAM actual amount"\)/);
  assert.doesNotMatch(body, /normalizeMoney\(actual\.rows\[0\]\?\.amount/);
});

test("finalizeCamPool fences and closes covered GL periods before reading source actuals", () => {
  const source = readFileSync(
    join(repoRoot, "engine/src/property-management.ts"),
    "utf8",
  );
  const start = source.indexOf("export async function finalizeCamPool");
  const next = source.indexOf("export async function billCamReconciliation");
  const body = source.slice(start, next);

  // Ordering invariants inside the finalized window.
  const fenceAt = body.indexOf("pg_advisory_xact_lock(hashtextextended($");
  const gateAt = body.indexOf("period_module_is_closed(");
  const readAt = body.indexOf("const actual = await sourceTotals()");
  const verifyAt = body.indexOf("CAM source ledgers changed while finalizing");
  const mutateAt = body.indexOf("delete from cam_allocations");

  // The exclusive side of the canonical journal-posting advisory key
  // ('period-lock:<org>:<period>:<book>') must be taken before the first
  // source read, sharing the key every guarded posting holds (migration 0022)
  // and close/reopen writers take exclusively.
  assert.ok(fenceAt > -1, "finalize must take the exclusive period-lock advisory fence");
  assert.ok(gateAt > -1, "finalize must require the covered GL modules closed");
  assert.ok(readAt > -1, "finalize must perform its fenced source totals read");
  assert.ok(fenceAt < readAt && gateAt < readAt, "fence and closed-period gate precede the source read");

  // Commit-time fingerprint recheck must sit between the last source read and
  // the first pool mutation, refusing stale finalizations instead of committing them.
  assert.ok(verifyAt > -1, "finalize must recheck the source fingerprint before commit");
  assert.ok(mutateAt > -1 && verifyAt < mutateAt, "fingerprint recheck precedes the pool mutation");

  // The scope covers every active book and every period overlapping the CAM
  // dates, adjustment periods included.
  assert.match(body, /join accounting_books b on b\.org_id=\$\{orgId\} and b\.is_active/);
  assert.match(body, /p\.starts_on<=\$\{pool\.period_ends_on\} and p\.ends_on>=\$\{pool\.period_starts_on\}/);

  // Finalization audit records source fingerprint and selected account/location scope.
  assert.match(body, /cam_pools", poolId, "finalize"/);
  assert.match(body, /sourceFingerprint/);
  assert.match(body, /locationId: pool\.location_id/);
  assert.match(body, /expenseAccountIds: pool\.expense_account_ids/);
});

test("CAM overlap is inclusive and excludes non-overlapping occupancy", () => {
  assert.equal(overlapDayCount("2026-01-15", "2026-03-15", "2026-01-01", "2026-12-31"), 60);
  assert.equal(overlapDayCount("2025-01-01", "2025-12-31", "2026-01-01", "2026-12-31"), 0);
  assert.equal(overlapDayCount("2026-12-31", "2027-01-31", "2026-01-01", "2026-12-31"), 1);
});
