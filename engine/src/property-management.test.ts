import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  PropertyManagementError,
  addLeaseCharge,
  addLeaseEscalation,
  createCamPool,
  updateCamPool,
  createManagedProperty,
  createPropertyLease,
  createPropertyUnit,
  terminatePropertyLease,
  depositBalance,
  isSecurityDepositImportConflict,
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

test("escalation and schedule helpers reject unknown policies instead of miscomputing", () => {
  // Before the guard, an unknown method fell through to the new_amount
  // branch: escalatedRent("2000", "bogus", "50") silently returned "50.0000".
  assert.throws(
    () => escalatedRent("2000", "bogus" as never, "50"),
    (error: unknown) => error instanceof PropertyManagementError && /Invalid escalation method/.test(error.message),
  );
  // Before the guard, an unknown frequency fell through to the annual
  // branch and materialised one twelve-month period.
  assert.throws(
    () => leaseChargeSchedule({
      amount: "1200",
      frequency: "bogus" as never,
      effectiveFrom: "2026-01-01",
      leaseStartsOn: "2026-01-01",
      throughOn: "2026-12-31",
      billingDay: 1,
    }),
    (error: unknown) => error instanceof PropertyManagementError && /Invalid charge frequency/.test(error.message),
  );
  // The enum is validated before the empty-window early return: an unknown
  // frequency with no overlapping window still throws instead of [].
  assert.throws(
    () => leaseChargeSchedule({
      amount: "1200",
      frequency: "bogus" as never,
      effectiveFrom: "2027-01-01",
      leaseStartsOn: "2026-01-01",
      throughOn: "2026-12-31",
      billingDay: 1,
    }),
    (error: unknown) => error instanceof PropertyManagementError && /Invalid charge frequency/.test(error.message),
  );
});

test("the import-conflict mapper only recognises the known deposit backstop", () => {
  const conflict = new Error("duplicate key value violates unique constraint", {
    cause: Object.assign(new Error("duplicate key"), { constraint: "security_deposits_import_key_once" }),
  });
  assert.equal(isSecurityDepositImportConflict(conflict), true);
  const other = new Error("duplicate key value violates unique constraint", {
    cause: Object.assign(new Error("duplicate key"), { constraint: "security_deposits_entry" }),
  });
  assert.equal(isSecurityDepositImportConflict(other), false);
  assert.equal(isSecurityDepositImportConflict(new Error("plain failure")), false);
  assert.equal(isSecurityDepositImportConflict(null), false);
});

const CREATE_IDS = {
  orgId: "00000000-0000-0000-0000-000000000000",
  actorId: "00000000-0000-0000-0000-000000000001",
  propertyId: "00000000-0000-0000-0000-000000000002",
  tenantId: "00000000-0000-0000-0000-000000000003",
  leaseId: "00000000-0000-0000-0000-000000000004",
  subsidiaryId: "00000000-0000-0000-0000-000000000005",
  poolId: "00000000-0000-0000-0000-000000000006",
};

function validLeaseInput() {
  return {
    ...CREATE_IDS,
    leaseNumber: "L-1",
    startsOn: "2026-01-01",
    endsOn: "2026-12-31",
    baseRent: "1000",
    billingDay: 1,
    paymentTermsDays: 0,
    securityDepositRequired: "0",
    camMethod: "none" as const,
    lateFeeType: "none" as const,
    lateFeeValue: "0",
    graceDays: 0,
    autoInvoice: true,
    autoPost: false,
  };
}

test("lease creation validates billing, terms, deposit, CAM, and late-fee policy before touching storage", async () => {
  // With no database configured any storage touch fails with a connection
  // error, so a PropertyManagementError proves the guard fired first.
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["billing day 99", { billingDay: 99 }, /Billing day must be between 1 and 31/],
    ["billing day 0", { billingDay: 0 }, /Billing day must be between 1 and 31/],
    ["negative payment terms", { paymentTermsDays: -7 }, /Payment terms and grace days/],
    ["negative grace days", { graceDays: -2 }, /Payment terms and grace days/],
    ["negative deposit", { securityDepositRequired: "-5" }, /Security deposit cannot be negative/],
    ["unknown CAM method", { camMethod: "bogus" }, /Invalid CAM method/],
    ["unknown late-fee type", { lateFeeType: "bogus", lateFeeValue: "5" }, /Invalid late-fee type/],
    ["late-fee percent over 100", { lateFeeType: "percent", lateFeeValue: "150" }, /Late-fee percent cannot exceed 100/],
    ["zero fixed late fee", { lateFeeType: "fixed", lateFeeValue: "0" }, /Late-fee value must be positive/],
  ];
  for (const [label, override, pattern] of cases) {
    await assert.rejects(
      () => createPropertyLease({ ...validLeaseInput(), ...override } as never),
      (error: unknown) => error instanceof PropertyManagementError && pattern.test(error.message),
      label,
    );
  }
});

test("property, unit, charge, escalation, and CAM creation validate enums, dates, and windows before touching storage", async () => {
  await assert.rejects(
    () => createManagedProperty({ ...CREATE_IDS, code: "P-1", name: "Bogus", propertyType: "castle" }),
    (error: unknown) => error instanceof PropertyManagementError && /Invalid property type/.test(error.message),
  );
  await assert.rejects(
    () => createPropertyUnit({ ...CREATE_IDS, code: "U-1", bedrooms: -2 }),
    (error: unknown) => error instanceof PropertyManagementError && /Bedrooms must be a non-negative whole number/.test(error.message),
  );
  const chargeBase = {
    ...CREATE_IDS,
    chargeType: "other",
    description: "Extra",
    amount: "10",
    frequency: "monthly",
    effectiveFrom: "2026-05-01",
  };
  await assert.rejects(
    () => addLeaseCharge({ ...chargeBase, effectiveFrom: "not-a-date" }),
    (error: unknown) => error instanceof PropertyManagementError && /Charge start is invalid/.test(error.message),
  );
  await assert.rejects(
    () => addLeaseCharge({ ...chargeBase, effectiveFrom: "" }),
    (error: unknown) => error instanceof PropertyManagementError && /Charge start is required/.test(error.message),
  );
  await assert.rejects(
    () => addLeaseCharge({ ...chargeBase, effectiveTo: "2026-04-01" }),
    (error: unknown) => error instanceof PropertyManagementError && /Charge end cannot precede start/.test(error.message),
  );
  await assert.rejects(
    () => addLeaseCharge({ ...chargeBase, frequency: "bogus" }),
    (error: unknown) => error instanceof PropertyManagementError && /Invalid charge frequency/.test(error.message),
  );
  await assert.rejects(
    () => addLeaseCharge({ ...chargeBase, chargeType: "bogus" }),
    (error: unknown) => error instanceof PropertyManagementError && /Invalid charge type/.test(error.message),
  );
  await assert.rejects(
    () => addLeaseEscalation({ ...CREATE_IDS, effectiveOn: "2026-07-01", method: "bogus" as never, value: "50" }),
    (error: unknown) => error instanceof PropertyManagementError && /Invalid escalation method/.test(error.message),
  );
  await assert.rejects(
    () => addLeaseEscalation({ ...CREATE_IDS, effectiveOn: "", method: "percent", value: "50" }),
    (error: unknown) => error instanceof PropertyManagementError && /Escalation date is required/.test(error.message),
  );
  const poolBase = {
    ...CREATE_IDS,
    name: "FY26",
    fiscalYear: 2026,
    periodStartsOn: "2026-07-01",
    periodEndsOn: "2026-07-31",
    allocationBasis: "bogus" as never,
    budgetAmount: "100",
    expenseAccountIds: ["00000000-0000-0000-0000-000000000007"],
  };
  await assert.rejects(
    () => createCamPool({ ...poolBase }),
    (error: unknown) => error instanceof PropertyManagementError && /Invalid CAM allocation basis/.test(error.message),
  );
  await assert.rejects(
    () => updateCamPool({ ...poolBase, poolId: CREATE_IDS.poolId }),
    (error: unknown) => error instanceof PropertyManagementError && /Invalid CAM allocation basis/.test(error.message),
  );
});

test("lease termination requires an explicit date before touching storage", async () => {
  // A blank date previously terminated the lease with a null move-out date.
  await assert.rejects(
    () => terminatePropertyLease(CREATE_IDS.orgId, CREATE_IDS.actorId, CREATE_IDS.leaseId, "", "Tenant left"),
    (error: unknown) => error instanceof PropertyManagementError && /Termination date is required/.test(error.message),
  );
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
