import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import {
  SubcontractError,
  addSubcontractSovLine,
  approveSubcontractChangeOrder,
  computeVendorApplication,
  createSubcontract,
  createSubcontractPaymentControl,
  createVendorPayApplication,
  parseSubcontractTransitionAction,
  releaseVendorRetainage,
  revisedSubcontractSovValue,
} from "./subcontracts.ts";
import { db } from "../platform/db.ts";

test("subcontract transition parser is strict and runs before transaction work", () => {
  for (const action of ["substantially_complete", "close", "void"] as const) {
    assert.equal(parseSubcontractTransitionAction(action), action);
  }

  for (const invalid of [
    "approve",
    "",
    "void ",
    undefined,
    null,
    42,
    { action: "void" },
    ["void"],
  ]) {
    assert.throws(
      () => parseSubcontractTransitionAction(invalid),
      (error) => error instanceof SubcontractError && error.message === "Invalid subcontract transition action",
    );
  }

  const source = readFileSync(new URL("./subcontracts.ts", import.meta.url), "utf8");
  const transitionStart = source.indexOf("export async function transitionSubcontract");
  const transactionStart = source.indexOf("await db.transaction", transitionStart);
  const parserStart = source.indexOf(
    "const action = parseSubcontractTransitionAction(input.action)",
    transitionStart,
  );
  assert.ok(transitionStart >= 0, "transitionSubcontract is defined");
  assert.ok(parserStart >= 0 && parserStart < transactionStart, "transition validation precedes transaction work");
});

test("vendor application treats stored materials as a cumulative balance", () => {
  const result = computeVendorApplication([{
    sovLineId: "line-1",
    scheduledValue: "1000",
    previousEarned: "400",
    previousMaterialsStored: "100",
    workCompletedThisPeriod: "150",
    materialsStoredCurrent: "50",
    retainagePercent: "10",
  }]);
  assert.deepEqual(result, {
    lines: [{
      sovLineId: "line-1",
      grossThisPeriod: "100.0000",
      retainageThisPeriod: "10.0000",
      netDue: "90.0000",
      earnedToDate: "500.0000",
      materialsStoredCurrent: "50.0000",
      remainingCommitment: "500.0000",
    }],
    grossThisPeriod: "100.0000",
    retainageThisPeriod: "10.0000",
    netDue: "90.0000",
  });
});
test("vendor two-decimal settlement rounds the cumulative retained amount and carries the residual", () => {
  const result = computeVendorApplication([{
    sovLineId: "line-1",
    scheduledValue: "10000",
    previousEarned: "0",
    previousMaterialsStored: "0",
    workCompletedThisPeriod: "3333.33",
    materialsStoredCurrent: "0",
    retainagePercent: "10",
  }, {
    sovLineId: "line-2",
    scheduledValue: "10000",
    previousEarned: "0",
    previousMaterialsStored: "0",
    workCompletedThisPeriod: "3333.33",
    materialsStoredCurrent: "0",
    retainagePercent: "5",
  }], { minorUnits: 2 });
  // Exact 333.333 + 166.6665 settles 333.33 + 166.67 = 500.00 exactly.
  assert.equal(result.lines[0]!.retainageThisPeriod, "333.3300");
  assert.equal(result.lines[1]!.retainageThisPeriod, "166.6700");
  assert.equal(result.retainageThisPeriod, "500.0000");
  assert.equal(result.netDue, "6166.6600");
});

test("vendor prior-draw replay carries the residual across draws", () => {
  const result = computeVendorApplication([{
    sovLineId: "line-1",
    scheduledValue: "10000",
    previousEarned: "333.33",
    previousMaterialsStored: "0",
    workCompletedThisPeriod: "333.33",
    materialsStoredCurrent: "0",
    retainagePercent: "10",
  }], { minorUnits: 2, priorExactRetainage: ["33.3333"] });
  // Cumulative exact 66.6666 rounds to 66.67; 33.33 already settled.
  assert.equal(result.retainageThisPeriod, "33.3400");
  assert.equal(result.lines[0]!.earnedToDate, "666.6600");
});

test("vendor application prevents stored-material double pay and overbilling", () => {
  assert.throws(() => computeVendorApplication([{
    sovLineId: "line-1",
    scheduledValue: "1000",
    previousEarned: "400",
    previousMaterialsStored: "100",
    workCompletedThisPeriod: "25",
    materialsStoredCurrent: "50",
    retainagePercent: "10",
  }]), /reduction in stored materials must be offset/);
  assert.throws(() => computeVendorApplication([{
    sovLineId: "line-1",
    scheduledValue: "450",
    previousEarned: "400",
    previousMaterialsStored: "0",
    workCompletedThisPeriod: "51",
    materialsStoredCurrent: "0",
    retainagePercent: "10",
  }]), /exceeds the revised SOV value/);
});

test("createSubcontract persists originalCommitment through canonicalDecimal then normalizeMoney", () => {
  const source = readFileSync(new URL("./subcontracts.ts", import.meta.url), "utf8");
  const helperStart = source.indexOf("function persistSubcontractOriginalCommitment");
  const helperEnd = source.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistSubcontractOriginalCommitment helper is defined");
  const helper = source.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);
  assert.match(helper, /SubcontractError/);

  const start = source.indexOf("export async function createSubcontract");
  const next = source.indexOf("export async function updateDraftSubcontract");
  const body = source.slice(start, next);
  assert.match(body, /persistSubcontractOriginalCommitment\(input\.originalCommitment\)/);
  assert.doesNotMatch(body, /normalizeMoney\(input\.originalCommitment\)/);
  assert.match(body, /persistSubcontractDefaultRetainage\(input\.defaultRetainagePercent \?\? "10"\)/);
  assert.doesNotMatch(body, /normalizeMoney\(input\.defaultRetainagePercent/);
});

test("createSubcontract persists defaultRetainagePercent through canonicalDecimal then normalizeMoney", () => {
  const source = readFileSync(new URL("./subcontracts.ts", import.meta.url), "utf8");
  const helperStart = source.indexOf("function persistSubcontractDefaultRetainage");
  const helperEnd = source.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistSubcontractDefaultRetainage helper is defined");
  const helper = source.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);
  assert.match(helper, /SubcontractError/);

  const start = source.indexOf("export async function createSubcontract");
  const next = source.indexOf("export async function updateDraftSubcontract");
  const body = source.slice(start, next);
  assert.match(body, /persistSubcontractDefaultRetainage\(input\.defaultRetainagePercent \?\? "10"\)/);
  assert.doesNotMatch(body, /normalizeMoney\(input\.defaultRetainagePercent/);
});

test("updateDraftSubcontract persists originalCommitment through canonicalDecimal then normalizeMoney", () => {
  const source = readFileSync(new URL("./subcontracts.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function updateDraftSubcontract");
  const next = source.indexOf("export async function addSubcontractSovLine");
  const body = source.slice(start, next);
  assert.ok(start >= 0 && next > start, "updateDraftSubcontract persist is defined");
  assert.match(body, /persistSubcontractOriginalCommitment\(input\.originalCommitment\)/);
  assert.doesNotMatch(body, /normalizeMoney\(input\.originalCommitment\)/);
  assert.match(body, /persistSubcontractDefaultRetainage\(input\.defaultRetainagePercent\)/);
  assert.doesNotMatch(body, /normalizeMoney\(input\.defaultRetainagePercent\)/);
});

test("updateDraftSubcontract persists defaultRetainagePercent through canonicalDecimal then normalizeMoney", () => {
  const source = readFileSync(new URL("./subcontracts.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function updateDraftSubcontract");
  const next = source.indexOf("export async function addSubcontractSovLine");
  const body = source.slice(start, next);
  assert.ok(start >= 0 && next > start, "updateDraftSubcontract retainage persist is defined");
  assert.match(body, /persistSubcontractDefaultRetainage\(input\.defaultRetainagePercent\)/);
  assert.doesNotMatch(body, /normalizeMoney\(input\.defaultRetainagePercent\)/);
  assert.match(body, /persistSubcontractOriginalCommitment\(input\.originalCommitment\)/);
});

test("addSubcontractSovLine persists scheduledValue through canonicalDecimal then normalizeMoney", () => {
  const source = readFileSync(new URL("./subcontracts.ts", import.meta.url), "utf8");
  const helperStart = source.indexOf("function persistSubcontractSovScheduledValue");
  const helperEnd = source.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistSubcontractSovScheduledValue helper is defined");
  const helper = source.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);
  assert.match(helper, /SubcontractError/);

  const start = source.indexOf("export async function addSubcontractSovLine");
  const next = source.indexOf("export async function removeSubcontractSovLine");
  const body = source.slice(start, next);
  assert.match(body, /persistSubcontractSovScheduledValue\(input\.scheduledValue\)/);
  assert.doesNotMatch(body, /normalizeMoney\(input\.scheduledValue\)/);
});

test("addSubcontractSovLine persists retainagePercent through canonicalDecimal then normalizeMoney", () => {
  const source = readFileSync(new URL("./subcontracts.ts", import.meta.url), "utf8");
  const helperStart = source.indexOf("function persistSubcontractSovRetainage");
  const helperEnd = source.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistSubcontractSovRetainage helper is defined");
  const helper = source.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);
  assert.match(helper, /SubcontractError/);

  const start = source.indexOf("export async function addSubcontractSovLine");
  const next = source.indexOf("export async function removeSubcontractSovLine");
  const body = source.slice(start, next);
  assert.match(body, /persistSubcontractSovRetainage\(input\.retainagePercent\)/);
  assert.doesNotMatch(body, /normalizeMoney\(input\.retainagePercent\)/);
  assert.match(body, /persistSubcontractSovScheduledValue\(input\.scheduledValue\)/);
});

test("createSubcontractChangeOrder persists amount through canonicalDecimal then normalizeMoney", () => {
  const source = readFileSync(new URL("./subcontracts.ts", import.meta.url), "utf8");
  const helperStart = source.indexOf("function persistSubcontractChangeOrderAmount");
  const helperEnd = source.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistSubcontractChangeOrderAmount helper is defined");
  const helper = source.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);
  assert.match(helper, /SubcontractError/);

  const start = source.indexOf("export async function createSubcontractChangeOrder");
  const next = source.indexOf("export async function approveSubcontractChangeOrder");
  const body = source.slice(start, next);
  assert.match(body, /persistSubcontractChangeOrderAmount\(input\.amount\)/);
  assert.doesNotMatch(body, /normalizeMoney\(input\.amount\)/);
});

test("releaseVendorRetainage persists amount through canonicalDecimal then normalizeMoney", () => {
  const source = readFileSync(new URL("./subcontracts.ts", import.meta.url), "utf8");
  const helperStart = source.indexOf("function persistSubcontractRetainageReleaseAmount");
  const helperEnd = source.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistSubcontractRetainageReleaseAmount helper is defined");
  const helper = source.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);
  assert.match(helper, /SubcontractError/);

  const start = source.indexOf("export async function releaseVendorRetainage");
  const next = source.indexOf("export async function createSubcontractPaymentControl");
  const body = source.slice(start, next);
  assert.match(body, /persistSubcontractRetainageReleaseAmount\(input\.amount\)/);
  assert.doesNotMatch(body, /normalizeMoney\(input\.amount\)/);
});

test("createSubcontractPaymentControl persists amountLimit through canonicalDecimal then normalizeMoney", () => {
  const source = readFileSync(new URL("./subcontracts.ts", import.meta.url), "utf8");
  const helperStart = source.indexOf("function persistSubcontractPaymentControlAmountLimit");
  const helperEnd = source.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistSubcontractPaymentControlAmountLimit helper is defined");
  const helper = source.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);
  assert.match(helper, /SubcontractError/);

  const start = source.indexOf("export async function createSubcontractPaymentControl");
  const next = source.indexOf("export async function releaseSubcontractPaymentControl");
  const body = source.slice(start, next);
  assert.match(body, /persistSubcontractPaymentControlAmountLimit\(input\.amountLimit\)/);
  assert.doesNotMatch(body, /normalizeMoney\(input\.amountLimit\)/);
});

test("computeVendorApplication persists previousEarned through canonicalDecimal then normalizeMoney", () => {
  const source = readFileSync(new URL("./subcontracts.ts", import.meta.url), "utf8");
  const helperStart = source.indexOf("function persistVendorPayApplicationPreviousEarned");
  const helperEnd = source.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistVendorPayApplicationPreviousEarned helper is defined");
  const helper = source.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);
  assert.match(helper, /SubcontractError/);

  const start = source.indexOf("export function computeVendorApplication");
  const next = source.indexOf("/** Deductive changes may never reduce a line below earned-to-date. */");
  const body = source.slice(start, next);
  assert.match(body, /persistVendorPayApplicationPreviousEarned\(input\.previousEarned\)/);
  assert.doesNotMatch(body, /normalizeMoney\(input\.previousEarned\)/);
});

test("computeVendorApplication persists previousMaterialsStored through canonicalDecimal then normalizeMoney", () => {
  const source = readFileSync(new URL("./subcontracts.ts", import.meta.url), "utf8");
  const helperStart = source.indexOf("function persistVendorPayApplicationPreviousMaterialsStored");
  const helperEnd = source.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistVendorPayApplicationPreviousMaterialsStored helper is defined");
  const helper = source.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);
  assert.match(helper, /SubcontractError/);

  const start = source.indexOf("export function computeVendorApplication");
  const next = source.indexOf("/** Deductive changes may never reduce a line below earned-to-date. */");
  const body = source.slice(start, next);
  assert.match(body, /persistVendorPayApplicationPreviousMaterialsStored\(input\.previousMaterialsStored\)/);
  assert.doesNotMatch(body, /normalizeMoney\(input\.previousMaterialsStored\)/);
});

test("computeVendorApplication persists workCompletedThisPeriod through canonicalDecimal then normalizeMoney", () => {
  const source = readFileSync(new URL("./subcontracts.ts", import.meta.url), "utf8");
  const helperStart = source.indexOf("function persistVendorPayApplicationWorkCompletedThisPeriod");
  const helperEnd = source.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistVendorPayApplicationWorkCompletedThisPeriod helper is defined");
  const helper = source.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);
  assert.match(helper, /SubcontractError/);

  const start = source.indexOf("export function computeVendorApplication");
  const next = source.indexOf("/** Deductive changes may never reduce a line below earned-to-date. */");
  const body = source.slice(start, next);
  assert.match(body, /persistVendorPayApplicationWorkCompletedThisPeriod\(input\.workCompletedThisPeriod\)/);
  assert.doesNotMatch(body, /normalizeMoney\(input\.workCompletedThisPeriod\)/);
});

test("computeVendorApplication persists materialsStoredCurrent through canonicalDecimal then normalizeMoney", () => {
  const source = readFileSync(new URL("./subcontracts.ts", import.meta.url), "utf8");
  const helperStart = source.indexOf("function persistVendorPayApplicationMaterialsStoredCurrent");
  const helperEnd = source.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistVendorPayApplicationMaterialsStoredCurrent helper is defined");
  const helper = source.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);
  assert.match(helper, /SubcontractError/);

  const start = source.indexOf("export function computeVendorApplication");
  const next = source.indexOf("/** Deductive changes may never reduce a line below earned-to-date. */");
  const body = source.slice(start, next);
  assert.match(body, /persistVendorPayApplicationMaterialsStoredCurrent\(input\.materialsStoredCurrent\)/);
  assert.doesNotMatch(body, /normalizeMoney\(input\.materialsStoredCurrent\)/);
});

test("computeVendorApplication persists retainagePercent through canonicalDecimal then normalizeMoney", () => {
  const source = readFileSync(new URL("./subcontracts.ts", import.meta.url), "utf8");
  const helperStart = source.indexOf("function persistVendorPayApplicationRetainagePercent");
  const helperEnd = source.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistVendorPayApplicationRetainagePercent helper is defined");
  const helper = source.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);
  assert.match(helper, /SubcontractError/);

  const start = source.indexOf("export function computeVendorApplication");
  const next = source.indexOf("/** Deductive changes may never reduce a line below earned-to-date. */");
  const body = source.slice(start, next);
  assert.match(body, /persistVendorPayApplicationRetainagePercent\(input\.retainagePercent\)/);
  assert.doesNotMatch(body, /normalizeMoney\(input\.retainagePercent\)/);
});

test("updateVendorPayApplicationLines persists workCompletedThisPeriod through canonicalDecimal then normalizeMoney", () => {
  const source = readFileSync(new URL("./subcontracts.ts", import.meta.url), "utf8");
  const helperStart = source.indexOf("function persistVendorPayApplicationWorkCompletedThisPeriod");
  const helperEnd = source.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistVendorPayApplicationWorkCompletedThisPeriod helper is defined");
  const helper = source.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);
  assert.match(helper, /SubcontractError/);

  const start = source.indexOf("export async function updateVendorPayApplicationLines");
  const next = source.indexOf("async function computeApplicationTx");
  const body = source.slice(start, next);
  assert.match(body, /persistVendorPayApplicationWorkCompletedThisPeriod\(update\.workCompletedThisPeriod\)/);
  assert.doesNotMatch(body, /normalizeMoney\(update\.workCompletedThisPeriod\)/);
});

test("updateVendorPayApplicationLines persists materialsStoredCurrent through canonicalDecimal then normalizeMoney", () => {
  const source = readFileSync(new URL("./subcontracts.ts", import.meta.url), "utf8");
  const helperStart = source.indexOf("function persistVendorPayApplicationMaterialsStoredCurrent");
  const helperEnd = source.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistVendorPayApplicationMaterialsStoredCurrent helper is defined");
  const helper = source.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);
  assert.match(helper, /SubcontractError/);

  const start = source.indexOf("export async function updateVendorPayApplicationLines");
  const next = source.indexOf("async function computeApplicationTx");
  const body = source.slice(start, next);
  assert.match(body, /persistVendorPayApplicationMaterialsStoredCurrent\(update\.materialsStoredCurrent\)/);
  assert.doesNotMatch(body, /normalizeMoney\(update\.materialsStoredCurrent\)/);
});

test("generateVendorPayApplicationBill persists line.gross through canonicalDecimal then normalizeMoney", () => {
  const source = readFileSync(new URL("./subcontracts.ts", import.meta.url), "utf8");
  const helperStart = source.indexOf("function persistVendorBillLineGross");
  const helperEnd = source.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistVendorBillLineGross helper is defined");
  const helper = source.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);
  assert.match(helper, /SubcontractError/);

  const start = source.indexOf("export async function generateVendorPayApplicationBill");
  const next = source.indexOf("export async function releaseVendorRetainage");
  const body = source.slice(start, next);
  assert.match(body, /persistVendorBillLineGross\(line\.gross\)/);
  assert.doesNotMatch(body, /normalizeMoney\(line\.gross\)/);
});

test("revisedSubcontractSovValue persists inputs through canonicalDecimal then normalizeMoney", () => {
  const source = readFileSync(new URL("./subcontracts.ts", import.meta.url), "utf8");
  for (const helper of [
    "persistRevisedSubcontractSovCurrentScheduledValue",
    "persistRevisedSubcontractSovChangeAmount",
    "persistRevisedSubcontractSovEarnedToDate",
  ] as const) {
    const helperStart = source.indexOf(`function ${helper}`);
    const helperEnd = source.indexOf("\n}", helperStart);
    assert.ok(helperStart >= 0 && helperEnd > helperStart, `${helper} helper is defined`);
    const body = source.slice(helperStart, helperEnd + 2);
    assert.match(body, /canonicalDecimal\(value, 4\)/);
    assert.match(body, /normalizeMoney\(exact\)/);
    assert.match(body, /SubcontractError/);
  }

  const start = source.indexOf("export function revisedSubcontractSovValue");
  const next = source.indexOf("async function assertFeatureEnabled");
  const fnBody = source.slice(start, next);
  assert.match(fnBody, /persistRevisedSubcontractSovCurrentScheduledValue\(currentScheduledValue\)/);
  assert.match(fnBody, /persistRevisedSubcontractSovChangeAmount\(changeAmount\)/);
  assert.match(fnBody, /persistRevisedSubcontractSovEarnedToDate\(earnedToDate\)/);
  assert.doesNotMatch(fnBody, /normalizeMoney\(currentScheduledValue\)/);
  assert.doesNotMatch(fnBody, /normalizeMoney\(changeAmount\)/);
  assert.doesNotMatch(fnBody, /normalizeMoney\(earnedToDate\)/);
});

test("deductive change cannot erase earned work", () => {
  assert.equal(revisedSubcontractSovValue("1000", "-200", "750"), "800.0000");
  assert.equal(revisedSubcontractSovValue("1000.00", "-200.0000", "750"), "800.0000");
  assert.throws(
    () => revisedSubcontractSovValue("1000", "-300", "750"),
    SubcontractError,
  );
  assert.throws(
    () => revisedSubcontractSovValue("not-a-number", "-200", "750"),
    SubcontractError,
  );
  assert.throws(
    () => revisedSubcontractSovValue("1000", "-200", "0.00005"),
    SubcontractError,
  );
});

test("subcontract dates are validated as calendar days before any database work", async (t) => {
  const transactionDb = db as unknown as { transaction(callback: unknown): Promise<unknown> };
  t.mock.method(transactionDb, "transaction", async () => {
    throw new Error("database work must not start for an invalid date");
  });
  const isDateError = (error: unknown) =>
    error instanceof SubcontractError && /valid calendar date/.test(error.message);
  const base = { orgId: "org-1", userId: "user-1", subcontractId: "sub-1" };
  // The route stringifies a missing approvedOn to "undefined"; that must be a
  // domain rejection, not a 22007 from the date column.
  await assert.rejects(approveSubcontractChangeOrder("org-1", "user-1", "co-1", "undefined"), isDateError);
  for (const bad of ["", "2026-02-30", "07/31/2026", "2026-7-1"]) {
    await assert.rejects(approveSubcontractChangeOrder("org-1", "user-1", "co-1", bad), isDateError, `approve(${bad})`);
    await assert.rejects(releaseVendorRetainage({ ...base, periodEnd: bad, amount: "100" }), isDateError, `release(${bad})`);
    await assert.rejects(createVendorPayApplication({ ...base, periodEnd: bad }), isDateError, `application(${bad})`);
    await assert.rejects(
      createSubcontractPaymentControl({ ...base, controlType: "payment_hold", reason: "Lien notice", effectiveOn: bad }),
      isDateError,
      `control effectiveOn(${bad})`,
    );
    // Optional dates: empty means "not set"; anything else must be a calendar day.
    if (bad === "") continue;
    await assert.rejects(
      createSubcontractPaymentControl({ ...base, controlType: "payment_hold", reason: "Lien notice", effectiveOn: "2026-07-01", expiresOn: bad }),
      isDateError,
      `control expiresOn(${bad})`,
    );
    await assert.rejects(
      createSubcontract({ ...base, projectId: "p-1", vendorId: "v-1", number: "S-1", title: "Roofing", originalCommitment: "1000", startsOn: bad }),
      isDateError,
      `subcontract startsOn(${bad})`,
    );
  }
});

/** Flatten a drizzle SQL chunk into raw text for lock-keyword assertions. */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return "";
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      const value = (chunk as { value?: unknown[] })?.value;
      if (Array.isArray(value)) return value.map(String).join("");
      if ((chunk as { queryChunks?: unknown[] })?.queryChunks) return sqlText(chunk);
      return "";
    })
    .join("");
}

type FakeTx = { execute: (query: unknown) => Promise<{ rows: Record<string, unknown>[] }> };

function mockTransaction(t: TestContext, features: Record<string, boolean>, seen: string[]): void {
  const tx: FakeTx = {
    execute: async (query: unknown) => {
      seen.push(sqlText(query));
      return { rows: [{ features }] };
    },
  };
  const transactionDb = db as unknown as {
    transaction(callback: (transaction: FakeTx) => Promise<unknown>): Promise<unknown>;
  };
  t.mock.method(
    transactionDb,
    "transaction",
    async (callback: (transaction: FakeTx) => Promise<unknown>) => callback(tx),
  );
}

const subcontractInput = {
  orgId: "org-1",
  userId: "user-1",
  projectId: "p-1",
  vendorId: "v-1",
  number: "S-1",
  title: "Roofing",
  originalCommitment: "1000",
};

test("createSubcontract takes the fence and rechecks both gates under shared row locks", async (t) => {
  const seen: string[] = [];
  mockTransaction(t, { projects: true, subcontracts: false }, seen);
  // The refusal names the gate. A concurrent disable commits first, so the
  // new subcontract must be refused, never committed hidden behind the gate.
  await assert.rejects(
    createSubcontract(subcontractInput),
    (error: unknown) =>
      error instanceof SubcontractError && error.message === "Subcontracts feature is disabled",
  );
  // Fence first, then both gates rechecked before any other database work:
  // the advisory lock serializes against the disable path's blocker checks
  // and each fenced read's shared org-row lock against its exclusive one.
  assert.equal(seen.length, 3);
  assert.match(seen[0]!, /pg_advisory_xact_lock/);
  for (const text of seen.slice(1)) {
    assert.match(text, /from orgs/);
    assert.match(text, /for share/);
  }
});

test("createSubcontract refuses a disabled Projects parent gate first", async (t) => {
  const seen: string[] = [];
  mockTransaction(t, { projects: false, subcontracts: true }, seen);
  await assert.rejects(
    createSubcontract(subcontractInput),
    (error: unknown) =>
      error instanceof SubcontractError && error.message === "Projects feature is disabled",
  );
  assert.equal(seen.length, 2);
  assert.match(seen[0]!, /pg_advisory_xact_lock/);
  assert.match(seen[1]!, /for share/);
});

test("createSubcontract proceeds past enabled gates to the project lookup", async (t) => {
  let calls = 0;
  const tx: FakeTx = {
    execute: async () => {
      calls += 1;
      if (calls === 1) return { rows: [] };
      if (calls <= 3) return { rows: [{ features: { projects: true, subcontracts: true } }] };
      throw new Error("beyond-gate");
    },
  };
  const transactionDb = db as unknown as {
    transaction(callback: (transaction: FakeTx) => Promise<unknown>): Promise<unknown>;
  };
  t.mock.method(
    transactionDb,
    "transaction",
    async (callback: (transaction: FakeTx) => Promise<unknown>) => callback(tx),
  );
  // Enabled gates must not refuse: the flow continues to the next check.
  await assert.rejects(createSubcontract(subcontractInput), /beyond-gate/);
});

test("createVendorPayApplication shares the same fenced gate", async (t) => {
  const seen: string[] = [];
  mockTransaction(t, { projects: true, subcontracts: false }, seen);
  await assert.rejects(
    createVendorPayApplication({ orgId: "org-1", userId: "user-1", subcontractId: "s-1", periodEnd: "2026-08-31" }),
    (error: unknown) =>
      error instanceof SubcontractError && error.message === "Subcontracts feature is disabled",
  );
  assert.ok(seen.length >= 2);
  assert.match(seen[0]!, /pg_advisory_xact_lock/);
  assert.match(seen[1]!, /for share/);
});

test("addSubcontractSovLine shares the same fenced gate", async (t) => {
  const seen: string[] = [];
  mockTransaction(t, { projects: false, subcontracts: false }, seen);
  await assert.rejects(
    addSubcontractSovLine({ orgId: "org-1", userId: "user-1", subcontractId: "s-1", description: "Demolition", scheduledValue: "500" }),
    (error: unknown) =>
      error instanceof SubcontractError && error.message === "Projects feature is disabled",
  );
  assert.ok(seen.length >= 2);
  assert.match(seen[0]!, /pg_advisory_xact_lock/);
  assert.match(seen[1]!, /for share/);
});
