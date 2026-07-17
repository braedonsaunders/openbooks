import assert from "node:assert/strict";
import test from "node:test";
import { mulRate } from "./money.ts";

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
