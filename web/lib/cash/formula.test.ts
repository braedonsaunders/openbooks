import assert from "node:assert/strict";
import test from "node:test";
import { evaluateFormula } from "./formula.ts";

// The cash formula engine is exact decimal end to end: literals parse as
// exact rationals, arithmetic and comparisons never cross IEEE-754, and the
// result renders as canonical numeric(19,4).

test("malformed literals refuse naming the position instead of evaluating a prefix", () => {
  assert.throws(() => evaluateFormula("1.2.3 + 4"), /Malformed numeric literal "1\.2\.3" at position 0/);
  assert.throws(() => evaluateFormula("1 + 2.3.4"), /Malformed numeric literal "2\.3\.4" at position 4/);
  assert.throws(() => evaluateFormula("1..2"), /Malformed numeric literal "1\.\.2" at position 0/);
  assert.throws(() => evaluateFormula("."), /Malformed numeric literal "\." at position 0/);
});

test("decimal arithmetic and equality are exact, not float", () => {
  assert.equal(evaluateFormula("0.1 + 0.2"), "0.3000");
  // The exact expression from the defect report, through the same IF→ternary
  // rewrite categoryWeekly applies before evaluating.
  const rewritten = "IF(0.1+0.2==0.3,100,0)"
    .replace(/IF\s*\(([^,]+),([^,]+),([^)]+)\)/g, "($1 ? $2 : $3)");
  assert.equal(evaluateFormula(rewritten), "100.0000");
  assert.equal(evaluateFormula("0.1 + 0.2 == 0.3"), "1.0000");
  assert.equal(evaluateFormula("1.5 - 1.05"), "0.4500");
  assert.equal(evaluateFormula("19.99 * 3"), "59.9700");
});

test("division renders repeating decimals at ledger scale, halves away from zero", () => {
  assert.equal(evaluateFormula("1 / 3"), "0.3333");
  assert.equal(evaluateFormula("2 / 3"), "0.6667");
  assert.equal(evaluateFormula("10 / 4"), "2.5000");
  assert.equal(evaluateFormula("1 / 0"), "0.0000");
  assert.equal(evaluateFormula("10 % 3"), "1.0000");
  assert.equal(evaluateFormula("10.5 % 3"), "1.5000");
  assert.equal(evaluateFormula("10 % 0"), "0.0000");
});

test("core grammar keeps working: precedence, comparisons, ternary, logic", () => {
  assert.equal(evaluateFormula("1 + 2 * 3"), "7.0000");
  assert.equal(evaluateFormula("(1 + 2) * 3"), "9.0000");
  assert.equal(evaluateFormula("-5 + 8"), "3.0000");
  assert.equal(evaluateFormula("5 > 3"), "1.0000");
  assert.equal(evaluateFormula("5 < 3"), "0.0000");
  assert.equal(evaluateFormula("5 != 3"), "1.0000");
  assert.equal(evaluateFormula("2 >= 2"), "1.0000");
  assert.equal(evaluateFormula("2 <= 1"), "0.0000");
  assert.equal(evaluateFormula("1 ? 10 : 20"), "10.0000");
  assert.equal(evaluateFormula("0 ? 10 : 20"), "20.0000");
  assert.equal(evaluateFormula("1 && 0"), "0.0000");
  assert.equal(evaluateFormula("0 && 0"), "0.0000");
  assert.equal(evaluateFormula("1 || 0"), "1.0000");
  assert.equal(evaluateFormula("0 || 0"), "0.0000");
  assert.equal(evaluateFormula("!0"), "1.0000");
  assert.equal(evaluateFormula("true + true"), "2.0000");
  assert.equal(evaluateFormula("false + 5"), "5.0000");
});

test("functions keep working on exact values", () => {
  assert.equal(evaluateFormula("min(3, 1, 2)"), "1.0000");
  assert.equal(evaluateFormula("max(3, 1, 2)"), "3.0000");
  assert.equal(evaluateFormula("abs(-2.5)"), "2.5000");
  assert.equal(evaluateFormula("ceil(2.1)"), "3.0000");
  assert.equal(evaluateFormula("floor(2.9)"), "2.0000");
  assert.equal(evaluateFormula("round(2.5)"), "3.0000");
  assert.equal(evaluateFormula("avg(1, 2, 3)"), "2.0000");
  assert.equal(evaluateFormula("avg(0.1, 0.2)"), "0.1500");
  assert.equal(evaluateFormula("pow(2, 10)"), "1024.0000");
  assert.equal(evaluateFormula("pow(2, -2)"), "0.2500");
  assert.equal(evaluateFormula("sqrt(2)"), "1.4142");
  assert.equal(evaluateFormula("min()"), "0.0000");
});

test("structural refusals still name the problem", () => {
  assert.throws(() => evaluateFormula(""), /Formula is empty/);
  assert.throws(() => evaluateFormula("1 +"), /Unexpected end of formula/);
  assert.throws(() => evaluateFormula("(1 + 2"), /Unexpected end of formula/);
  assert.throws(() => evaluateFormula("1 2"), /trailing formula content "2" at position 2/);
  assert.throws(() => evaluateFormula("1 & 2"), /Unsupported character "&" in formula at position 2/);
  assert.throws(() => evaluateFormula("nosuchfn(1)"), /Unsupported formula function: nosuchfn/);
  assert.throws(() => evaluateFormula("bogus"), /Unsupported formula token: bogus at position 0/);
  assert.throws(() => evaluateFormula("12,34"), /trailing formula content/);
});

test("large literals stay exact past float precision", () => {
  assert.equal(evaluateFormula("9007199254740993 + 0"), "9007199254740993.0000");
  assert.equal(evaluateFormula("9007199254740993 == 9007199254740992"), "0.0000");
});
