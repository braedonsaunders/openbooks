import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalDecimal,
  compareDecimal,
  fixedDecimal,
  isPositiveDecimal,
  isZeroDecimal,
} from "./exact-decimal.ts";

test("canonicalDecimal strips padding and signs without floats", () => {
  // A mutant that keeps raw text fails the padding rows; one that drops the
  // negative-zero rule fails the zero rows; one that ignores maxScale fails
  // the null rows.
  const cases: Array<[unknown, number, string | null]> = [
    ["0012.3400", 4, "12.34"],
    ["-0.00", 4, "0"],
    ["+0.00", 4, "0"],
    ["+5", 2, "5"],
    ["1.", 4, "1"],
    ["-0.0001", 4, "-0.0001"],
    ["0", 0, "0"],
    ["-0", 0, "0"],
    ["100.10", 4, "100.1"],
    ["1.234", 2, null],
    ["1.234", 3, "1.234"],
    [".5", 4, null],
    ["abc", 4, null],
    ["", 4, null],
    ["1.2.3", 4, null],
    ["--1", 4, null],
    ["1.5", -1, null],
    [null, 4, null],
    [undefined, 4, null],
  ];
  for (const [input, scale, expected] of cases) {
    assert.equal(canonicalDecimal(input, scale), expected, `canonicalDecimal(${String(input)}, ${scale})`);
  }
});

test("compareDecimal compares value, not spelling or scale", () => {
  // A string-compare mutant orders "1.10" after "1.1" and "-2" before "-10".
  const cases: Array<[string, string, -1 | 0 | 1]> = [
    ["1.10", "1.1", 0],
    ["001.50", "1.5", 0],
    ["-0.00", "0", 0],
    ["0.5", "0.25", 1],
    ["1.5", "2", -1],
    ["-2", "-10", 1],
    ["-10", "-2", -1],
    ["100.0001", "100.0002", -1],
    ["0", "0.0000", 0],
  ];
  for (const [left, right, expected] of cases) {
    assert.equal(compareDecimal(left, right), expected, `compareDecimal(${left}, ${right})`);
  }
});

test("zero and positivity predicates treat every zero spelling as zero", () => {
  for (const zero of ["0", "0.00", "-0.0", "+0.000", "000"]) {
    assert.equal(isZeroDecimal(zero), true, `isZeroDecimal(${zero})`);
    assert.equal(isPositiveDecimal(zero), false, `isPositiveDecimal(${zero})`);
  }
  assert.equal(isZeroDecimal("0.0001"), false);
  assert.equal(isZeroDecimal("-5"), false);
  assert.equal(isPositiveDecimal("0.0001"), true);
  assert.equal(isPositiveDecimal("-0.0001"), false);
  assert.equal(isPositiveDecimal("-5"), false);
});

test("fixedDecimal pads to width and refuses to round silently", () => {
  assert.equal(fixedDecimal("1.5", 2), "1.50");
  assert.equal(fixedDecimal("-1.5", 2), "-1.50");
  assert.equal(fixedDecimal("001.50", 2), "1.50");
  assert.equal(fixedDecimal("-0.00", 2), "0.00");
  assert.throws(() => fixedDecimal("1.555", 2), /invalid decimal/);
  assert.throws(() => fixedDecimal("abc", 2), /invalid decimal/);
});
