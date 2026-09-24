import assert from "node:assert/strict";
import test from "node:test";
import { isValidEmployerFactEffectiveDate, registerEmployerFacts, resolveEmployerFact } from "./employer-facts.ts";
import { PayrollPackError } from "./payroll-error.ts";

const country = "ZZ";
registerEmployerFacts(country, [
  { key: "effectif", kind: "decimal", scale: 2, min: "0", max: "1000000", label: "annual employer effectif", refusalReason: "CSS L.130-1 annual legal-employer average", legalBasis: "CSS L.130-1 and R.130-1", required: true },
  { key: "tier", kind: "choice", choices: [{ value: "a", label: "A" }, { value: "b", label: "B" }], label: "employer tier", refusalReason: "the applicable tier must be selected", legalBasis: "test declaration", required: true },
  { key: "sector", kind: "integer", min: "1", max: "9", label: "sector code", refusalReason: "sector is required", legalBasis: "test declaration", required: true },
  { key: "enabled", kind: "boolean", label: "eligibility", refusalReason: "eligibility is required", legalBasis: "test declaration", required: true },
]);

test("employer fact resolver validates decimals exactly to their pack-declared scale", () => {
  assert.equal(resolveEmployerFact(country, "effectif", "49.90"), "49.90");
  assert.throws(
    () => resolveEmployerFact(country, "effectif", "49.901"),
    /annual employer effectif.*exact decimal.*2 fractional digits/,
  );
});

test("employer fact resolver validates enum, integer bounds, and boolean primitives", () => {
  assert.equal(resolveEmployerFact(country, "tier", "b"), "b");
  assert.equal(resolveEmployerFact(country, "sector", "9"), "9");
  assert.equal(resolveEmployerFact(country, "enabled", "false"), "false");
  assert.throws(() => resolveEmployerFact(country, "tier", "c"), /must be one of a, b/);
  assert.throws(() => resolveEmployerFact(country, "sector", "1.0"), /whole safe integer/);
  assert.throws(() => resolveEmployerFact(country, "enabled", "yes"), /true.*false/);
});

test("required facts refuse by the operator-facing name and legal remedy", () => {
  assert.throws(
    () => resolveEmployerFact(country, "effectif", null),
    (error: unknown) => error instanceof PayrollPackError
      && /annual employer effectif/.test(error.message)
      && /CSS L.130-1/.test(error.message)
      && /Payroll Setup → Employer facts/.test(error.message),
  );
});

test("employer fact effective dates reject calendar rollover dates", () => {
  for (const [year, februaryDays] of [[2024, 29], [2025, 28]] as const) {
    for (const [month, lastDay] of [
      [1, 31], [2, februaryDays], [3, 31], [4, 30], [5, 31], [6, 30],
      [7, 31], [8, 31], [9, 30], [10, 31], [11, 30], [12, 31],
    ] as const) {
      const prefix = `${year}-${String(month).padStart(2, "0")}`;
      assert.equal(isValidEmployerFactEffectiveDate(`${prefix}-${String(lastDay).padStart(2, "0")}`), true);
      assert.equal(isValidEmployerFactEffectiveDate(`${prefix}-${String(lastDay + 1).padStart(2, "0")}`), false);
    }
  }
  assert.equal(isValidEmployerFactEffectiveDate("0000-01-01"), false);
});
