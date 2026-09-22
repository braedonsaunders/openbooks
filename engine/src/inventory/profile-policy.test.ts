import assert from "node:assert/strict";
import { test } from "node:test";
import { parseUnitConversions } from "./profile-policy.ts";

/**
 * The costing profile's unit-conversion map is the only thing standing
 * between a foreign unit spelling and a posting refusal, so its write-time
 * validation must be strict: non-blank names to positive, exactly
 * representable factors. Anything looser would reach toBaseQuantity as a
 * guess at posting time.
 */

test("parseUnitConversions accepts a well-formed map and trims names", () => {
  assert.deepEqual(parseUnitConversions({ box: 12, " pallet ": 720 }), {
    box: 12,
    pallet: 720,
  });
  assert.deepEqual(parseUnitConversions({ Each: 1, kg: 2.5 }), {
    Each: 1,
    kg: 2.5,
  });
});

test("parseUnitConversions leaves omission alone and clears on null", () => {
  assert.equal(parseUnitConversions(undefined), undefined);
  assert.deepEqual(parseUnitConversions(null), {});
  assert.deepEqual(parseUnitConversions({}), {});
});

test("parseUnitConversions refuses anything that cannot convert exactly", () => {
  assert.equal(parseUnitConversions([]), "invalid");
  assert.equal(parseUnitConversions("box"), "invalid");
  assert.equal(parseUnitConversions(12), "invalid");
  assert.equal(parseUnitConversions({ "": 12 }), "invalid");
  assert.equal(parseUnitConversions({ "   ": 12 }), "invalid");
  assert.equal(parseUnitConversions({ box: 0 }), "invalid");
  assert.equal(parseUnitConversions({ box: -12 }), "invalid");
  assert.equal(parseUnitConversions({ box: Number.NaN }), "invalid");
  assert.equal(parseUnitConversions({ box: Number.POSITIVE_INFINITY }), "invalid");
  assert.equal(parseUnitConversions({ box: "12" }), "invalid");
  // 1/3 as a float cannot multiply exact 4dp quantities without inventing
  // precision.
  assert.equal(parseUnitConversions({ third: 1 / 3 }), "invalid");
  assert.equal(parseUnitConversions({ tiny: 0.00001 }), "invalid");
});
