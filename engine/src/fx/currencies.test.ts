import assert from "node:assert/strict";
import test from "node:test";
import {
  CurrencyError,
  settleCumulativeRetainage,
  updateFxRate,
  roundCurrencyMoney,
} from "./currencies.ts";

test("updateFxRate persists FX at numeric(19,10) and fails closed", () => {
  assert.equal(updateFxRate({ rate: "1.25" }), "1.2500000000");
  assert.equal(updateFxRate({ rate: "001.2500000000" }), "1.2500000000");
  assert.throws(() => updateFxRate({ rate: "0" }), CurrencyError);
  assert.throws(() => updateFxRate({ rate: "-1.25" }), CurrencyError);
  assert.throws(() => updateFxRate({ rate: "1e-2" }), CurrencyError);
  assert.throws(() => updateFxRate({ rate: "1.25000000001" }), CurrencyError);
  assert.equal(updateFxRate({ rate: "0.0000000011" }), "0.0000000011");
  assert.equal(updateFxRate({ rate: "999999999.9999999999" }), "999999999.9999999999");
  assert.throws(() => updateFxRate({ rate: "0.0000000010" }), /rate and its inverse fit numeric\(19,10\)/);
  assert.throws(() => updateFxRate({ rate: "1000000000" }), /rate and its inverse fit numeric\(19,10\)/);
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

test("retainage settlement carries dust so settled batches sum exactly", () => {
  // Thirds in a two-decimal currency: the middle draw absorbs the rounding.
  assert.deepEqual(settleCumulativeRetainage([], ["33.3333", "33.3333", "33.3334"], 2), [
    "33.3300",
    "33.3400",
    "33.3300",
  ]);
  // Prior draws replay through the same policy: history already settled 10.01,
  // so the current draw takes the 10.00 remainder and the all-time settled
  // total is the rounded cumulative 20.01, never the truncated 20.00.
  assert.deepEqual(settleCumulativeRetainage(["10.005"], ["10.005"], 2), ["10.0000"]);
  // Zero and four minor units are the identity; anything outside 0..4 refuses
  // with the domain error (a bare RangeError from the exponent is not it).
  assert.deepEqual(settleCumulativeRetainage([], ["1.2345"], 0), ["1.0000"]);
  assert.deepEqual(settleCumulativeRetainage([], ["1.2345"], 4), ["1.2345"]);
  for (const units of [-1, 1.5, 5, NaN]) {
    assert.throws(() => settleCumulativeRetainage([], ["1"], units), CurrencyError);
  }
});

test("a dust-negative payable keeps its sign at full precision", () => {
  assert.equal(roundCurrencyMoney("-0.0001", 4), "-0.0001");
  assert.equal(roundCurrencyMoney("0.0000", 4), "0.0000");
});

test("non-positive FX rates are refused as non-positive, not as malformed", () => {
  assert.throws(() => updateFxRate({ rate: "-1.25" }), /greater than zero/);
  assert.throws(() => updateFxRate({ rate: "0" }), /greater than zero/);
  assert.throws(() => updateFxRate({ rate: "abc" }), /exact decimal/);
});
