import assert from "node:assert/strict";
import test from "node:test";
import { CurrencyError, updateFxRate } from "./currencies.ts";

test("updateFxRate persists FX at numeric(19,10) and fails closed", () => {
  assert.equal(updateFxRate({ rate: "1.25" }), "1.2500000000");
  assert.equal(updateFxRate({ rate: "001.2500000000" }), "1.2500000000");
  assert.throws(() => updateFxRate({ rate: "0" }), CurrencyError);
  assert.throws(() => updateFxRate({ rate: "-1.25" }), CurrencyError);
  assert.throws(() => updateFxRate({ rate: "1e-2" }), CurrencyError);
  assert.throws(() => updateFxRate({ rate: "1.25000000001" }), CurrencyError);
});
