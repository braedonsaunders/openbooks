import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILTIN_FORMULAS,
  computeScheduleByFormula,
  DepreciationFormulaError,
  evalDepFormula,
  type DepContext,
  type FormulaScheduleInput,
} from "./depreciation-formula.ts";
import { toUnits } from "./money.ts";

const ctx = (over: Partial<DepContext> = {}): DepContext => ({
  OC: 10000, CC: 10000, NB: 10000, RV: 0, AL: 5, CP: 1, TD: 0, LD: 0,
  CU: 0, LU: 0, DH: 1, DP: 1, FY: 12, PB: 0, ...over,
});

// --- evaluator --------------------------------------------------------------

test("evaluates variables and arithmetic with correct precedence", () => {
  assert.equal(evalDepFormula("(OC-RV)/AL", ctx({ OC: 12000, AL: 12 })), "1000");
  assert.equal(evalDepFormula("2+3*4", ctx()), "14");
  assert.equal(evalDepFormula("(2+3)*4", ctx()), "20");
  assert.equal(evalDepFormula("2^3^2", ctx()), "512"); // right-associative
  assert.equal(evalDepFormula("-NB+CC", ctx({ NB: 3000, CC: 10000 })), "7000");
});

test("'~' takes the greater operand (DB↔SL crossover primitive)", () => {
  assert.equal(evalDepFormula("100~250", ctx()), "250");
  assert.equal(evalDepFormula("(NB-RV)*(2/AL)~(NB-RV)/(AL-CP+1)", ctx({ NB: 2160, AL: 5, CP: 4 })), "1080");
});

test("IF/THEN/ELSE and ROUND", () => {
  assert.equal(evalDepFormula("IF NB > RV THEN 5 ELSE 0 ENDIF", ctx({ NB: 100, RV: 0 })), "5");
  assert.equal(evalDepFormula("IF NB > RV THEN 5 ELSE 0 ENDIF", ctx({ NB: 0, RV: 0 })), "0");
  assert.equal(evalDepFormula("ROUND(1234.5678, 2)", ctx()), "1234.57");
  assert.equal(evalDepFormula("ROUND(10/3)", ctx()), "3.33");
});

test("rate-table variables R1..Rn", () => {
  assert.equal(evalDepFormula("OC*R2", ctx({ OC: 1000, R: ["0.2", "0.32", "0.192"] }) as DepContext), "320");
});

test("rejects unknown variables and injection attempts", () => {
  assert.throws(() => evalDepFormula("FOO*2", ctx()), DepreciationFormulaError);
  assert.throws(() => evalDepFormula("process.exit(1)", ctx()), DepreciationFormulaError);
  assert.throws(() => evalDepFormula("OC; DROP", ctx()), DepreciationFormulaError);
  assert.throws(() => evalDepFormula("(OC", ctx()), DepreciationFormulaError);
});

test("rejects division by zero instead of silently producing a zero charge", () => {
  const formula = "(OC-RV)/0";
  assert.throws(() => evalDepFormula(formula, ctx()), /formula denominator cannot be zero/);
  assert.throws(() => computeScheduleByFormula({
    cost: "100.0000", salvage: "0", lifePeriods: 2, formula, endOfLife: "retain_balance",
  }), /formula denominator cannot be zero/);
});

// --- formula-driven schedule ------------------------------------------------

const money = (lines: { planned: string }[]) => lines.reduce((total, line) => total + toUnits(line.planned), 0n);
const sl = (over: Partial<FormulaScheduleInput>): FormulaScheduleInput => ({
  cost: "12000", salvage: "0", lifePeriods: 12, formula: BUILTIN_FORMULAS.straight_line, ...over,
});

test("straight-line matches an even split and totals exactly", () => {
  const lines = computeScheduleByFormula(sl({}));
  assert.equal(lines.length, 12);
  assert.equal(lines[0]!.planned, "1000.0000");
  assert.equal(money(lines), toUnits("12000"));
  assert.equal(lines[11]!.netBookValue, "0.0000");
});

test("sum-of-years-digits front-loads and totals to cost − salvage", () => {
  // AL=5, base 9000: P1 = 9000*5/15 = 3000; P5 = 9000*1/15 = 600.
  const lines = computeScheduleByFormula({
    cost: "10000", salvage: "1000", lifePeriods: 5, formula: BUILTIN_FORMULAS.sum_of_years_digits,
  });
  assert.equal(lines[0]!.planned, "3000.0000");
  assert.equal(lines[4]!.netBookValue, "1000.0000"); // lands on salvage
  assert.equal(money(lines), toUnits("9000"));
});

test("double-declining crosses over to straight-line and finishes cleanly", () => {
  // cost 10000, salvage 0, life 5, 40%/period declining vs SL-remaining.
  const lines = computeScheduleByFormula({
    cost: "10000", salvage: "0", lifePeriods: 5, formula: BUILTIN_FORMULAS.double_declining,
  });
  assert.equal(lines[0]!.planned, "4000.0000"); // 40% of 10000
  assert.equal(lines[1]!.planned, "2400.0000"); // 40% of 6000
  // P4: DB would be 0.4*2160=864 but SL-remaining 2160/2=1080 wins (crossover).
  assert.equal(lines[3]!.planned, "1080.0000");
  assert.equal(lines[4]!.netBookValue, "0.0000");
  assert.equal(money(lines), toUnits("10000"));
});

test("units-of-production charges by usage and retains balance (no plug)", () => {
  const lines = computeScheduleByFormula({
    cost: "11000", salvage: "1000", lifePeriods: 3, formula: BUILTIN_FORMULAS.units_of_production,
    usage: [2000, 3000, 5000], lifetimeUsage: 10000, endOfLife: "retain_balance",
  });
  assert.deepEqual(lines.map((l) => l.planned), ["2000.0000", "3000.0000", "5000.0000"]);
  assert.equal(lines[2]!.netBookValue, "1000.0000"); // 10000 usage → fully used, lands on salvage
});

test("a part-period convention prorates period 1 and extends the schedule", () => {
  // Mid-month: half of month 1, full months 2..12, the deferred half in month 13.
  const lines = computeScheduleByFormula(sl({ firstPeriodFraction: 0.5 }));
  assert.equal(lines.length, 13);
  assert.equal(lines[0]!.planned, "500.0000");
  assert.equal(lines[1]!.planned, "1000.0000");
  assert.equal(lines[12]!.planned, "500.0000"); // deferred fraction plugged at the end
  assert.equal(lines[12]!.netBookValue, "0.0000");
  assert.equal(money(lines), toUnits("12000")); // total unchanged
});

test("INVARIANT: fully_depreciate methods total exactly cost − salvage, NBV = salvage", () => {
  for (const formula of [BUILTIN_FORMULAS.straight_line, BUILTIN_FORMULAS.declining_150, BUILTIN_FORMULAS.double_declining, BUILTIN_FORMULAS.sum_of_years_digits]) {
    const lines = computeScheduleByFormula({ cost: "8000", salvage: "500", lifePeriods: 36, formula });
    assert.equal(money(lines), toUnits("7500"), formula);
    assert.equal(lines[lines.length - 1]!.netBookValue, "500.0000", formula);
  }
});

test("schedule arithmetic stays exact beyond JavaScript's safe integer", () => {
  const lines = computeScheduleByFormula({
    cost: "900719925474.0991",
    salvage: "0.0001",
    lifePeriods: 3,
    formula: BUILTIN_FORMULAS.straight_line,
  });
  assert.equal(money(lines), toUnits("900719925474.0990"));
  assert.equal(lines.at(-1)!.netBookValue, "0.0001");
});
