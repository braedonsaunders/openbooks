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
  assert.match(body, /normalizeMoney\(input\.defaultRetainagePercent \?\? "10"\)/);
});

test("deductive change cannot erase earned work", () => {
  assert.equal(revisedSubcontractSovValue("1000", "-200", "750"), "800.0000");
  assert.throws(
    () => revisedSubcontractSovValue("1000", "-300", "750"),
    SubcontractError,
  );
});
