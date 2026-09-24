import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalDecimal,
  compareDecimal,
  divideDecimal,
  fixedDecimal,
  isPositiveDecimal,
  isZeroDecimal,
  parseExactDecimal,
} from "./exact-decimal.ts";
import { normalizeMoney } from "./money.ts";
import { decimalNullCause, decimalNullRefusal } from "./decimal-refusal.ts";

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
    // Leading-dot is the kernel's grammar too (toUnits accepts it): the
    // boundary normalizes it rather than refusing it as "not a number".
    [".5", 4, "0.5"],
    ["-.5", 4, "-0.5"],
    ["+.50", 2, "0.5"],
    [".000", 4, "0"],
    [".55555", 4, null],
    [".", 4, null],
    ["+", 4, null],
    ["abc", 4, null],
    ["", 4, null],
    ["1.2.3", 4, null],
    ["--1", 4, null],
    ["1.5", -1, null],
    [null, 4, null],
    [undefined, 4, null],
    [100, 4, null],
    [100.25, 4, null],
  ];
  for (const [input, scale, expected] of cases) {
    assert.equal(canonicalDecimal(input, scale), expected, `canonicalDecimal(${String(input)}, ${scale})`);
  }
});

test("boundary and kernel agree on dot spellings and garbage stays refused", () => {
  // The script-journal gate (persistJournalLineAmount) refuses exactly what
  // canonicalDecimal refuses, while the kernel posts whatever toUnits reads.
  // These spellings must agree: a spelling the kernel posts must pass the
  // gate, and the gate's canonical output must post unchanged.
  for (const spelling of [".5", "5.", "-.5", "+.5", "0.5", "5"]) {
    const canonical = canonicalDecimal(spelling, 4);
    assert.notEqual(canonical, null, `${spelling} passes the boundary`);
    assert.equal(normalizeMoney(canonical!), normalizeMoney(spelling));
  }
  assert.equal(canonicalDecimal(".5", 4), "0.5");
  assert.equal(canonicalDecimal("5.", 4), "5");
  for (const garbage of ["abc", "1.2.3", "12,34", "$5", "1e3", ""]) {
    assert.equal(canonicalDecimal(garbage, 4), null, `${garbage} is refused`);
  }
  assert.equal(canonicalDecimal(100.25, 4), null, "JSON numbers are refused rather than stringified");
});

test("JSON numeric input gets a named decimal-string remedy", () => {
  assert.deepEqual(decimalNullCause(100.25), { cause: "json-number" });
  assert.match(
    decimalNullRefusal("amount", "a monetary amount", 100.25, 4),
    /sent as a decimal string, not a JSON number/,
  );
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

test("parseExactDecimal accepts finite decimals without Number and refuses the rest", () => {
  assert.equal(parseExactDecimal("106497.9938"), "106497.9938");
  assert.equal(parseExactDecimal("  +0.50  "), "0.50");
  assert.equal(parseExactDecimal("1e3"), "1000");
  assert.equal(parseExactDecimal("1.5e-3"), "0.0015");
  assert.equal(parseExactDecimal("-0.00"), "0.00");
  for (const bad of ["abc", "", "1.2.3", "--1", "0x10", "Infinity", "NaN", null, undefined, 12]) {
    assert.equal(parseExactDecimal(bad), null, `parseExactDecimal(${String(bad)})`);
  }
});

test("divideDecimal divides exactly with halves away from zero", () => {
  // A float mutant prints 0.6184794712 here; the exact quotient rounds to ...713.
  assert.equal(divideDecimal("106497.9938", "172193.2558", 10), "0.6184794713");
  assert.equal(divideDecimal("1", "3", 10), "0.3333333333");
  assert.equal(divideDecimal("2", "3", 10), "0.6666666667");
  assert.equal(divideDecimal("-2", "3", 10), "-0.6666666667");
  assert.equal(divideDecimal("85000", "100000", 10), "0.8500000000");
  assert.equal(divideDecimal("5", "2", 0), "3");
  assert.equal(divideDecimal("4", "2", 4), "2.0000");
  assert.throws(() => divideDecimal("1", "0", 10), /cannot divide/);
  assert.throws(() => divideDecimal("abc", "1", 10), /not exact decimals/);
});
