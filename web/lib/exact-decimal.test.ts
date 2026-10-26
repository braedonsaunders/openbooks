import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalDecimal,
  compareDecimal,
  editableMoneyDecimal,
  fixedDecimal,
  isPositiveDecimal,
  isZeroDecimal,
  sameMoneyDecimal,
} from "./exact-decimal.ts";

test("request decimal handling never crosses the floating-point boundary", () => {
  assert.equal(canonicalDecimal("9007199254740993.1234"), "9007199254740993.1234");
  assert.equal(canonicalDecimal("00012.3400"), "12.34");
  assert.equal(canonicalDecimal("-0.0000"), "0");
  assert.equal(canonicalDecimal("1.00001"), null);
  assert.equal(canonicalDecimal("1e3"), null);
  assert.equal(compareDecimal("9007199254740993.0001", "9007199254740993"), 1);
  assert.equal(compareDecimal("-0.0001", "0"), -1);
  assert.equal(isPositiveDecimal("0.0001"), true);
  assert.equal(isZeroDecimal("0.0000"), true);
  assert.equal(fixedDecimal("12.34", 4), "12.3400");
});

test("stored money shows its canonical spelling with two places minimum", () => {
  assert.equal(editableMoneyDecimal("5028.8200"), "5028.82");
  assert.equal(editableMoneyDecimal("5028.5000"), "5028.50");
  assert.equal(editableMoneyDecimal("5028.8250"), "5028.825");
  assert.equal(editableMoneyDecimal("5028.0000"), "5028.00");
  assert.equal(editableMoneyDecimal("-12.0000"), "-12.00");
  assert.equal(editableMoneyDecimal("-0.5000"), "-0.50");
  assert.equal(editableMoneyDecimal("0.0000"), "0.00");
  assert.equal(editableMoneyDecimal(" 1000.1000 "), "1000.10");
  assert.equal(editableMoneyDecimal(null), "");
  assert.equal(editableMoneyDecimal("   "), "");
});

test("money text that is not plain decimal is shown as stored, never reparsed", () => {
  assert.equal(editableMoneyDecimal("1e3"), "1e3");
  assert.equal(editableMoneyDecimal("12.345678"), "12.345678");
});

test("money spellings compare by exact amount, not by padding", () => {
  assert.equal(sameMoneyDecimal("1000.00", "1000.0000"), true);
  assert.equal(sameMoneyDecimal("5028.82", "5028.8200"), true);
  assert.equal(sameMoneyDecimal("5028.82", "5028.8201"), false);
  assert.equal(sameMoneyDecimal("", null), true);
  assert.equal(sameMoneyDecimal(" ", null), true);
  assert.equal(sameMoneyDecimal("1", null), false);
});
