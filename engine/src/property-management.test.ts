import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  PropertyManagementError,
  addLeaseCharge,
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

test("CAM overlap is inclusive and excludes non-overlapping occupancy", () => {
  assert.equal(overlapDayCount("2026-01-15", "2026-03-15", "2026-01-01", "2026-12-31"), 60);
  assert.equal(overlapDayCount("2025-01-01", "2025-12-31", "2026-01-01", "2026-12-31"), 0);
  assert.equal(overlapDayCount("2026-12-31", "2027-01-31", "2026-01-01", "2026-12-31"), 1);
});

test("the generic lease-charge API refuses base_rent before touching storage", async () => {
  // Lease creation and controlled escalations are the only valid paths to a
  // base-rent row; the storage constraint (0057) backs this up for direct
  // writes, and the guard fires before any database connection is needed.
  await assert.rejects(
    addLeaseCharge({
      orgId: "00000000-0000-0000-0000-000000000000",
      actorId: "00000000-0000-0000-0000-000000000001",
      leaseId: "00000000-0000-0000-0000-000000000002",
      chargeType: "base_rent",
      description: "Second rent",
      amount: "1200",
      frequency: "monthly",
      effectiveFrom: "2026-08-01",
    }),
    (error: unknown) =>
      error instanceof PropertyManagementError
      && /Base rent changes belong on the lease/.test(error.message),
  );
});
