import assert from "node:assert/strict";
import test from "node:test";
import { allocateByRelativeSSP, fairValueRangeFlag, RevenueRecognitionError } from "./revenue-recognition.ts";
import { sum } from "./money.ts";

test("relative SSP uses unit quantities and preserves the whole transaction price", () => {
  assert.deepEqual(allocateByRelativeSSP("1000", [
    { ssp: "100", quantity: "9" }, { ssp: "100", quantity: "1" },
  ]), ["900.0000", "100.0000"]);
});

test("relative SSP retains all eight quantity decimals without rounding weights", () => {
  assert.deepEqual(allocateByRelativeSSP("100", [
    { ssp: "0.0001", quantity: "0.00000009" },
    { ssp: "0.0001", quantity: "0.00000001" },
  ]), ["90.0000", "10.0000"]);
});

test("booked fallback is already extended and shares the SSP product scale", () => {
  assert.deepEqual(allocateByRelativeSSP("1000", [
    { ssp: "100", quantity: "9" }, { booked: "100", quantity: "9" },
  ]), ["900.0000", "100.0000"]);
});

test("relative SSP preserves negative corrections and rounding residuals", () => {
  const obligations = [{ ssp: "1" }, { ssp: "1" }, { ssp: "1" }];
  assert.deepEqual(allocateByRelativeSSP("-1", obligations), ["-0.3334", "-0.3333", "-0.3333"]);
  assert.equal(sum(allocateByRelativeSSP("999999999999999.9999", obligations)), "999999999999999.9999");
});

test("nonzero allocation refuses missing or zero weights", () => {
  for (const obligations of [[], [{}], [{ ssp: "0" }], [{ ssp: "1", quantity: "0" }]]) {
    assert.throws(() => allocateByRelativeSSP("1000", obligations), RevenueRecognitionError);
  }
  assert.deepEqual(allocateByRelativeSSP("0", [{ ssp: "0" }]), ["0.0000"]);
  assert.deepEqual(allocateByRelativeSSP("0", []), []);
});

test("relative SSP refuses negative weights and invalid quantities", () => {
  for (const obligation of [
    { ssp: "-1" }, { ssp: "-1", quantity: "0" }, { booked: "-1" }, { ssp: "1", quantity: "-1" },
    { ssp: "1", quantity: "0.000000001" }, { ssp: "1", quantity: "NaN" },
  ]) assert.throws(() => allocateByRelativeSSP("100", [obligation]), RevenueRecognitionError);
});

test("fair-value review accepts eight-decimal quantities and exact boundaries", () => {
  assert.equal(fairValueRangeFlag("0.0001", "0.00000001", "10000", "10000"), null);
  assert.equal(fairValueRangeFlag("0.0001", "0.00000001", "10000.0001", null), "below_range");
  assert.equal(fairValueRangeFlag("0.0001", "0.00000001", null, "9999.9999"), "above_range");
});

test("fair-value review does not round a fractional bound onto the allocated price", () => {
  assert.equal(fairValueRangeFlag("0.0001", "0.0001", "1.0001", null), "below_range");
  assert.equal(fairValueRangeFlag("0.0001", "0.0001", null, "0.9999"), "above_range");
});
