import assert from "node:assert/strict";
import test from "node:test";
import { abs, mul, mulRate } from "./money.ts";

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
