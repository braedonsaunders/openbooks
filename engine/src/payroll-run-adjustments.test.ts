import assert from "node:assert/strict";
import test from "node:test";
import { canonicalAdjustmentHours } from "./payroll-run-adjustments.ts";

/**
 * Adjustment hours persist into numeric(12,2): the HTTP seam must hand the
 * engine at most 2dp. The route used to widen hours through the 4dp money
 * normalizer, so EVERY hours-bearing adjustment died in the engine gate and
 * the pay-run review step could never record hours (the E2E payroll suite
 * proves it end to end).
 */
test("adjustment hours keep quarter-hour precision without money padding", () => {
  assert.equal(canonicalAdjustmentHours("80"), "80");
  assert.equal(canonicalAdjustmentHours("80.5"), "80.5");
  assert.equal(canonicalAdjustmentHours("7.25"), "7.25");
});

test("adjustment hours refuse over-precise, negative, and out-of-range input", () => {
  assert.equal(canonicalAdjustmentHours("7.255"), null);
  assert.equal(canonicalAdjustmentHours("-1"), null);
  assert.equal(canonicalAdjustmentHours("nope"), null);
  assert.equal(canonicalAdjustmentHours("12345678901"), null);
});

test("adjustment hours treat absent input as no hours", () => {
  assert.equal(canonicalAdjustmentHours(null), null);
  assert.equal(canonicalAdjustmentHours(undefined), null);
  assert.equal(canonicalAdjustmentHours(""), null);
});
