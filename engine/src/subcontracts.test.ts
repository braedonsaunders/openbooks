import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  SubcontractError,
  computeVendorApplication,
  revisedSubcontractSovValue,
} from "./subcontracts.ts";

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

test("deductive change cannot erase earned work", () => {
  assert.equal(revisedSubcontractSovValue("1000", "-200", "750"), "800.0000");
  assert.throws(
    () => revisedSubcontractSovValue("1000", "-300", "750"),
    SubcontractError,
  );
});
