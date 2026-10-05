import assert from "node:assert/strict";
import { test } from "node:test";
import { compileExpression, ExpressionError, EXPRESSION_LIMITS, type ExpressionInput, type ExpressionRounding } from "./expression.ts";

const rounding: ExpressionRounding = { scale: 4, mode: "half_away_from_zero", maxWholeDigits: 15 };
const definitions: ExpressionInput[] = [
  { name: "base", type: { kind: "money", currency: "CAD" } },
  { name: "usd", type: { kind: "money", currency: "USD" } },
  { name: "hours", type: { kind: "hours" } },
  { name: "rate", type: { kind: "hourly_rate", currency: "CAD" } },
  { name: "factor", type: { kind: "scalar" } },
  { name: "eligible", type: { kind: "boolean" } },
];
function result(source: string, inputs: Record<string, unknown> = {}, policy = rounding): string | boolean {
  return compileExpression(source, definitions).evaluate(inputs, policy).value;
}
function refuses(action: () => unknown, code: ExpressionError["code"], message: RegExp): void {
  assert.throws(action, (error: unknown) => error instanceof ExpressionError && error.code === code && message.test(error.message));
}

test("decimal arithmetic and division remain exact until the output boundary", () => {
  assert.equal(result("0.1 + 0.2 - 0.3"), "0.0000");
  assert.equal(result("1 / 3 * 3"), "1.0000");
  assert.equal(result("(1 / 3 + 1 / 3 + 1 / 3) * 19.99"), "19.9900");
  assert.equal(result("999999999999999 + 0.0001 - 999999999999999"), "0.0001");
  assert.equal(result("-7 / -2"), "3.5000");
});

test("signed ties, half-even, and truncation obey the declared rounding rule", () => {
  const cents = { ...rounding, scale: 2 };
  assert.equal(result("1.005", {}, cents), "1.01");
  assert.equal(result("-1.005", {}, cents), "-1.01");
  assert.equal(result("1.005", {}, { ...cents, mode: "half_even" }), "1.00");
  assert.equal(result("1.015", {}, { ...cents, mode: "half_even" }), "1.02");
  assert.equal(result("-1.015", {}, { ...cents, mode: "half_even" }), "-1.02");
  assert.equal(result("-1.009", {}, { ...cents, mode: "towards_zero" }), "-1.00");
  assert.equal(result("-0.001", {}, cents), "0.00");
});

test("hours and hourly rates produce money in the rate currency", () => {
  const formula = compileExpression("hours * rate", definitions);
  assert.deepEqual(formula.resultType, { kind: "money", currency: "CAD" });
  assert.equal(formula.evaluate({ hours: "7.5", rate: "23.45" }, rounding).value, "175.8750");
  assert.deepEqual(compileExpression("base / hours", definitions).resultType, { kind: "hourly_rate", currency: "CAD" });
  assert.deepEqual(compileExpression("base / rate", definitions).resultType, { kind: "hours" });
  assert.deepEqual(compileExpression("base / base", definitions).resultType, { kind: "scalar" });
});

test("a literal inherits the surrounding amount or hours unit", () => {
  assert.equal(result("base + 25", { base: "100" }), "125.0000");
  assert.equal(result("if(hours > 0, hours * rate, 0)", { hours: "2", rate: "12" }), "24.0000");
  assert.equal(result("min(0, base)", { base: "100" }), "0.0000");
  assert.equal(result("clamp(base, 0, 100)", { base: "200" }), "100.0000");
  refuses(() => compileExpression("base + factor", definitions), "TYPE_MISMATCH", /money \(CAD\).*scalar/);
});

test("cross-currency arithmetic and incompatible units refuse before values are supplied", () => {
  for (const source of ["base + usd", "base / usd", "base < usd", "min(base, usd)", "if(eligible, base, usd)"]) {
    refuses(() => compileExpression(source, definitions), "TYPE_MISMATCH", /CAD.*USD/);
  }
  refuses(() => compileExpression("hours + base", definitions), "TYPE_MISMATCH", /hours.*money/);
  refuses(() => compileExpression("base * base", definitions), "TYPE_MISMATCH", /Cannot multiply/);
  refuses(() => compileExpression("eligible + 1", definitions), "TYPE_MISMATCH", /boolean.*amount/);
});

test("conditional evaluation does not execute an inapplicable division", () => {
  assert.equal(result("if(hours == 0, 0, base / hours * hours)", { hours: "0", base: "120" }), "0.0000");
  assert.equal(result("if(hours == 0, 0, base / hours * hours)", { hours: "3", base: "120" }), "120.0000");
  refuses(() => result("base / hours", { base: "120", hours: "0" }), "DIVISION_BY_ZERO", /correct the divisor.*if/);
  refuses(() => compileExpression("if(eligible, base, undeclared)", definitions), "INVALID_EXPRESSION", /names "undeclared".*available inputs are base.*rate/);
  refuses(() => compileExpression("if(eligible, base, usd)", definitions), "TYPE_MISMATCH", /CAD.*USD/);
});

test("boolean operations require booleans and support exact comparisons", () => {
  assert.equal(result("and(eligible, base >= 100, not(hours == 0))", { eligible: true, base: "100", hours: "1" }), true);
  assert.equal(result("or(eligible, factor == 0.3)", { eligible: false, factor: "0.3" }), true);
  assert.equal(result("0.1 + 0.2 == 0.3"), true);
  assert.equal(result("eligible != not(eligible)", { eligible: true }), true);
  refuses(() => compileExpression("if(factor, 1, 0)", definitions), "TYPE_MISMATCH", /boolean condition/);
  refuses(() => result("eligible", { eligible: "true" }), "INVALID_INPUT", /must be a boolean/);
});

test("all declared dependencies must be supplied, even in an inactive branch", () => {
  refuses(() => result("if(eligible, base, base * factor)", { eligible: true, base: "100" }), "INVALID_INPUT", /"factor" is missing.*never become zero/);
  refuses(() => result("base", { base: null }), "INVALID_INPUT", /"base" is missing/);
  refuses(() => result("base", Object.create({ base: "100" }) as Record<string, unknown>), "INVALID_INPUT", /missing/);
});

test("the shared decimal classifier gives precise comma remedies and never changes the amount", () => {
  refuses(() => result("base", { base: "12,34" }), "INVALID_INPUT", /write "12,34" as "12.34"/);
  refuses(() => result("base", { base: "1.234,56" }), "INVALID_INPUT", /as "1234.56"/);
  refuses(() => result("base", { base: "1,234" }), "INVALID_INPUT", /could mean 1234.*1.234/);
  refuses(() => result("base", { base: 12.34 }), "INVALID_INPUT", /decimal string.*JSON number/);
  refuses(() => result("base", { base: "1e3" }), "INVALID_INPUT", /scientific notation/);
});

test("input and output precision and magnitude bounds refuse rather than truncate", () => {
  refuses(() => result("factor", { factor: "0.1234567890123456789" }), "INVALID_INPUT", /at most 18 decimal places/);
  refuses(() => result("base", { base: "1000000000000000" }), "LIMIT", /at most 15 whole digits/);
  refuses(() => result("99.995", {}, { ...rounding, scale: 2, maxWholeDigits: 2 }), "LIMIT", /rounded formula result exceeds 2/);
  refuses(() => result("1", {}, { ...rounding, scale: -1 }), "INVALID_INPUT", /Declare a rounding mode/);
  refuses(() => result("1", {}, { ...rounding, mode: "unknown" } as unknown as ExpressionRounding), "INVALID_INPUT", /Declare a rounding mode/);
});

test("min/max and clamp use exact comparisons and refuse reversed bounds", () => {
  assert.equal(result("min(0.1 + 0.2, 0.300000000000000001)", {}, { ...rounding, scale: 18 }), "0.300000000000000000");
  assert.equal(result("max(-2, -1, -3)"), "-1.0000");
  refuses(() => result("clamp(5, 10, 1)"), "INVALID_INPUT", /lower bound above its upper bound/);
  for (const source of ["clamp(1, 2)", "if(eligible, 1)", "min()", "not(eligible, eligible)"]) {
    assert.throws(() => compileExpression(source, definitions), ExpressionError);
  }
});

test("code-like syntax, unknown names and incomplete expressions refuse", () => {
  for (const source of ["base.constructor", "process.env", "base[0]", "(()=>1)()", "pow(2, 3)", "1e3", "1 2", "1 +", "(1 + 2", "1 < 2 < 3", ""]) {
    assert.throws(() => compileExpression(source, definitions), ExpressionError, source);
  }
});

test("source size, token count, nesting and exact intermediate work are bounded", () => {
  refuses(() => compileExpression("1".repeat(EXPRESSION_LIMITS.characters + 1), definitions), "LIMIT", /characters/);
  refuses(() => compileExpression(Array(258).fill("1").join("+"), definitions), "LIMIT", /tokens/);
  refuses(() => compileExpression("(".repeat(34) + "1" + ")".repeat(34), definitions), "LIMIT", /nested expressions/);
  refuses(() => result(Array(20).fill("999999999999999").join("*")), "LIMIT", /exact-arithmetic limit/);
  refuses(() => result("base", { base: "0".repeat(65) }), "LIMIT", /64 characters/);
});

test("compiled definitions and evidence cannot be reinterpreted by later caller mutation", () => {
  const mutable: ExpressionInput[] = [{ name: "base", type: { kind: "money", currency: "CAD" } }];
  const formula = compileExpression("base + 1", mutable);
  mutable[0] = { name: "base", type: { kind: "money", currency: "USD" } };
  assert.deepEqual(formula.resultType, { kind: "money", currency: "CAD" });
  assert.deepEqual(formula.dependencies, ["base"]);
  const evidence = formula.evaluate({ base: "+00100.00", unrelated: "private" }, rounding);
  assert.equal(evidence.value, "101.0000");
  assert.equal(evidence.inputs.base, "100");
  assert.equal(Object.hasOwn(evidence.inputs, "unrelated"), false);
  assert.ok(Object.isFrozen(formula) && Object.isFrozen(formula.resultType) && Object.isFrozen(formula.dependencies) && Object.isFrozen(evidence.inputs));
});

test("input definition names and units are validated at compilation", () => {
  for (const bad of [
    [{ name: "bad.name", type: { kind: "scalar" } }],
    [{ name: "min", type: { kind: "scalar" } }],
    [{ name: "x", type: { kind: "money", currency: "cad" } }],
    [{ name: "x", type: { kind: "unknown" } }],
    [{ name: "x", type: { kind: "scalar" } }, { name: "x", type: { kind: "scalar" } }],
  ]) assert.throws(() => compileExpression("1", bad as ExpressionInput[]), ExpressionError);
});

test("addition and cancellation hold over exact decimal input samples", () => {
  const formula = compileExpression("(base + 0.1) - 0.1", definitions);
  for (let cents = -250; cents <= 250; cents += 1) {
    const sign = cents < 0 ? "-" : "";
    const magnitude = Math.abs(cents);
    const input = `${sign}${Math.floor(magnitude / 100)}.${String(magnitude % 100).padStart(2, "0")}`;
    assert.equal(formula.evaluate({ base: input }, rounding).value, `${input}00`);
  }
});
