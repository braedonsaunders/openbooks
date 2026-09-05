import assert from "node:assert/strict";
import test from "node:test";
import { CurrencyError, updateFxRate, roundCurrencyMoney } from "./currencies.ts";

test("updateFxRate persists FX at numeric(19,10) and fails closed", () => {
  assert.equal(updateFxRate({ rate: "1.25" }), "1.2500000000");
  assert.equal(updateFxRate({ rate: "001.2500000000" }), "1.2500000000");
  assert.throws(() => updateFxRate({ rate: "0" }), CurrencyError);
  assert.throws(() => updateFxRate({ rate: "-1.25" }), CurrencyError);
  assert.throws(() => updateFxRate({ rate: "1e-2" }), CurrencyError);
  assert.throws(() => updateFxRate({ rate: "1.25000000001" }), CurrencyError);
});


test("payable money honors zero through four minor units, signs and exact large amounts", () => {
  assert.equal(roundCurrencyMoney("100.5000", 0), "101.0000");
  assert.equal(roundCurrencyMoney("-100.5000", 0), "-101.0000");
  assert.equal(roundCurrencyMoney("100.4999", 0), "100.0000");
  assert.equal(roundCurrencyMoney("1.2500", 1), "1.3000");
  assert.equal(roundCurrencyMoney("1.2345", 2), "1.2300");
  assert.equal(roundCurrencyMoney("-1.2345", 3), "-1.2350");
  assert.equal(roundCurrencyMoney("1.2345", 4), "1.2345");
  assert.equal(roundCurrencyMoney("900719925474.0999", 2), "900719925474.1000");
  for (const exponent of [-1, 1.5, 5, NaN, Infinity]) {
    assert.throws(() => roundCurrencyMoney("1", exponent), CurrencyError);
  }
});
