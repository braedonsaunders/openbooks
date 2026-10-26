import assert from "node:assert/strict";
import test from "node:test";
import {
  displayEnteredAmount,
  isAmountExpression,
  parsePastedAmount,
  resolveEnteredAmount,
} from "./entry-amount";

test("plain amounts resolve to the ledger scale exactly", () => {
  assert.deepEqual(resolveEnteredAmount("247.83"), {
    kind: "amount",
    value: "247.8300",
    computed: false,
  });
  assert.deepEqual(resolveEnteredAmount("-12.5"), {
    kind: "amount",
    value: "-12.5000",
    computed: false,
  });
  assert.deepEqual(resolveEnteredAmount(""), { kind: "empty" });
});

test("arithmetic is exact and rounds once, halves away from zero", () => {
  assert.deepEqual(resolveEnteredAmount("200+47.83"), {
    kind: "amount",
    value: "247.8300",
    computed: true,
  });
  assert.deepEqual(resolveEnteredAmount("=12*4.5"), {
    kind: "amount",
    value: "54.0000",
    computed: true,
  });
  assert.deepEqual(resolveEnteredAmount("(100-15)/2"), {
    kind: "amount",
    value: "42.5000",
    computed: true,
  });
  // 0.1 + 0.2 is exactly 0.3 here, unlike binary floating point.
  assert.deepEqual(resolveEnteredAmount("0.1+0.2"), {
    kind: "amount",
    value: "0.3000",
    computed: true,
  });
  assert.deepEqual(resolveEnteredAmount("10/3"), {
    kind: "amount",
    value: "3.3333",
    computed: true,
  });
  assert.deepEqual(resolveEnteredAmount("2/3"), {
    kind: "amount",
    value: "0.6667",
    computed: true,
  });
  assert.deepEqual(resolveEnteredAmount("=-0.00005"), {
    kind: "amount",
    value: "-0.0001",
    computed: true,
  });
});

test("unreadable text and division by zero are refused, never guessed", () => {
  assert.deepEqual(resolveEnteredAmount("12,50"), { kind: "invalid" });
  assert.deepEqual(resolveEnteredAmount("200+"), { kind: "invalid" });
  assert.deepEqual(resolveEnteredAmount("5/0"), { kind: "invalid" });
  assert.deepEqual(resolveEnteredAmount("abc"), { kind: "invalid" });
  assert.deepEqual(resolveEnteredAmount("9999999999999999"), { kind: "invalid" });
});

test("auto decimal places the point before the currency minor units for digit-only entry", () => {
  assert.deepEqual(resolveEnteredAmount("1785", { autoDecimal: true }), {
    kind: "amount",
    value: "17.8500",
    computed: false,
  });
  assert.deepEqual(resolveEnteredAmount("5", { autoDecimal: true }), {
    kind: "amount",
    value: "0.0500",
    computed: false,
  });
  assert.deepEqual(resolveEnteredAmount("-250", { autoDecimal: true }), {
    kind: "amount",
    value: "-2.5000",
    computed: false,
  });
  assert.deepEqual(resolveEnteredAmount("17.85", { autoDecimal: true }), {
    kind: "amount",
    value: "17.8500",
    computed: false,
  });
  assert.deepEqual(resolveEnteredAmount("1785", { autoDecimal: true, minorUnits: 0 }), {
    kind: "amount",
    value: "1785.0000",
    computed: false,
  });
  assert.deepEqual(resolveEnteredAmount("1785", { autoDecimal: true, minorUnits: 3 }), {
    kind: "amount",
    value: "1.7850",
    computed: false,
  });
});

test("stored amounts display at currency precision without losing significant digits", () => {
  assert.equal(displayEnteredAmount("247.8300"), "247.83");
  assert.equal(displayEnteredAmount("1785.0000"), "1785.00");
  assert.equal(displayEnteredAmount("1785"), "1785.00");
  assert.equal(displayEnteredAmount("1.2345"), "1.2345");
  assert.equal(displayEnteredAmount("5.0000", 0), "5");
  assert.equal(displayEnteredAmount(""), "");
});

test("expressions are told apart from signed numbers", () => {
  assert.equal(isAmountExpression("200+47.83"), true);
  assert.equal(isAmountExpression("=5"), true);
  assert.equal(isAmountExpression("-50"), false);
  assert.equal(isAmountExpression("50"), false);
});

test("spreadsheet amounts accept symbols, accounting negatives and unambiguous grouping only", () => {
  assert.equal(parsePastedAmount("$1,234.50"), "1234.5000");
  assert.equal(parsePastedAmount("(12.00)"), "-12.0000");
  assert.equal(parsePastedAmount("1,234,567"), "1234567.0000");
  assert.equal(parsePastedAmount("52.99"), "52.9900");
  assert.equal(parsePastedAmount("100-"), "-100.0000");
  // "1,234" alone could be 1.234 in a comma-decimal locale: refused.
  assert.equal(parsePastedAmount("1,234"), null);
  assert.equal(parsePastedAmount("12,5"), null);
  assert.equal(parsePastedAmount("n/a"), null);
});

test("plain amounts refuse excess precision without rounding and explicit calculations retain rounding", () => {
  for (const value of ["12.34567", "0.00005", "-0.00005", "--5"])
    assert.deepEqual(resolveEnteredAmount(value), { kind: "invalid" });
  assert.equal(parsePastedAmount("12.34567"), null);
  assert.deepEqual(resolveEnteredAmount("1.23000"), {
    kind: "amount",
    value: "1.2300",
    computed: false,
  });
  assert.deepEqual(resolveEnteredAmount("+1785", { autoDecimal: true }), {
    kind: "amount",
    value: "17.8500",
    computed: false,
  });
  assert.deepEqual(resolveEnteredAmount("=1785", { autoDecimal: true }), {
    kind: "amount",
    value: "1785.0000",
    computed: true,
  });
});
