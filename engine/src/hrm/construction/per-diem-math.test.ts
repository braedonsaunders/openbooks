import assert from "node:assert/strict";
import test from "node:test";
import { mul } from "../../money/money.ts";
import { HrmConstructionError } from "./errors.ts";
import { allowanceProduct, quantizeDistanceKm } from "./per-diem.ts";

test("allowanceProduct rounds half away from zero instead of truncating the 8dp product", () => {
  // Old multiplyDecimal did (a*b)/10000 with integer truncation: 2.6750 × 1.0000
  // stays 2.6750 either way, but 0.3333 × 3.0000 is 0.9999 after canonical
  // rounding of the 8dp product, not a silent floor.
  assert.equal(allowanceProduct("0.3333", "3.0000"), mul("0.3333", "3.0000"));
  assert.equal(allowanceProduct("2.6750", "1.0000"), "2.6750");
  assert.equal(allowanceProduct("8.2500", "12.3456"), mul("8.2500", "12.3456"));
});

test("allowanceProduct refuses more than 4 decimal places instead of slicing them off", () => {
  assert.throws(
    () => allowanceProduct("1.23456", "10.0000"),
    (error: unknown) =>
      error instanceof HrmConstructionError
      && /beyond 4 decimal places/.test(error.message)
      && /4-decimal/.test(error.message),
  );
});

test("quantizeDistanceKm is a named 4dp kilometre quantity, never a float toFixed later", () => {
  assert.equal(quantizeDistanceKm(12.34567), "12.3457");
  assert.equal(quantizeDistanceKm(0), "0.0000");
  assert.throws(() => quantizeDistanceKm(Number.NaN), /finite/);
  assert.throws(() => quantizeDistanceKm(-1), /negative/);
});
