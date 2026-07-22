import assert from "node:assert/strict";
import test from "node:test";
import { abs, formatMoney, mul, mulDecimal, mulDecimalFactors, mulPercent, mulRate, mulRatio, normalizeMoney, roundDiv, roundMoney, toUnits } from "./money.ts";

test("mul handles quantity math, zero rates and exact rounding", () => {
  assert.equal(mul("3", "12.3456"), "37.0368");
  assert.equal(mul("4", "0"), "0.0000");
  assert.equal(mul("-2", "1.2500"), "-2.5000");
  assert.equal(mul("0.3333", "3.0000"), "0.9999");
});

test("abs preserves exact four-decimal money units", () => {
  assert.equal(abs("-0.0001"), "0.0001");
  assert.equal(abs("12.3400"), "12.3400");
  assert.equal(abs("0"), "0.0000");
});

test("mulRate translates money exactly at numeric(19,10) precision", () => {
  assert.equal(mulRate("100.0000", "1.3512345678"), "135.1235");
  assert.equal(mulRate("-100.0000", "1.3512345678"), "-135.1235");
  assert.equal(mulRate("0.0100", "0.5000000000"), "0.0050");
});

test("mulRate rejects zero, negative, and over-precise rates", () => {
  assert.throws(() => mulRate("1", "0"), /greater than zero/);
  assert.throws(() => mulRate("1", "-1"), /positive FX rate/);
  assert.throws(() => mulRate("1", "1.00000000001"), /precision/);
});

test("mulPercent remains exact across the full numeric(19,4) money range", () => {
  assert.equal(mulPercent("900719925474099.1250", "13", 2), "117093590311632.8900");
  assert.equal(mulPercent("999999999999999.9500", "13", 2), "129999999999999.9900");
  assert.equal(mulPercent("-10.0500", "5", 2), "-0.5000");
  assert.equal(mulPercent("0.1000", "7.25", 4), "0.0073");
});

test("mulRatio allocates exact partial carrying values", () => {
  assert.equal(mulRatio("120.0000", 1n, 3n), "40.0000");
  assert.equal(mulRatio("100.0000", 1n, 6n), "16.6667");
  assert.equal(toUnits(mulRatio("100.0000", 5n, 6n)) + toUnits("16.6667"), toUnits("100.0000"));
});

test("normalization and rational rounding never depend on binary floats", () => {
  assert.equal(normalizeMoney("00012.3"), "12.3000");
  assert.equal(roundDiv(5n, 2n), 3n);
  assert.equal(roundDiv(-5n, 2n), -3n);
});

test("roundMoney and formatMoney round exact ledger units without binary drift", () => {
  assert.equal(roundMoney("900719925474099.9950", 2), "900719925474100.0000");
  assert.equal(formatMoney("1.0050", 2), "1.01");
  assert.equal(formatMoney("-1.0050", 2), "-1.01");
});

test("decimal factors preserve ten-place rates and combine before rounding", () => {
  assert.equal(mulDecimal("900719925474099.1250", "0.13"), "117093590311632.8863");
  assert.equal(mulDecimalFactors("10000", ["0.3", "0.5"]), "1500.0000");
});
