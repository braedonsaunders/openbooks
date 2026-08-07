import assert from "node:assert/strict";
import test from "node:test";
import {
  assertEarningsAssessedStable,
  dropIncomeAssessedLines,
} from "../payroll-limits.ts";
import {
  PAYROLL_COUNTRY_PACKS,
  PayrollPackError,
  packStatutoryComponents,
  statutoryAssessment,
  type PayrollAssessedOn,
} from "./packs.ts";

/**
 * The country packs' `assessedOn` declaration — what each statutory amount is
 * computed FROM, and therefore whether the deduction-protection fixpoint in
 * calculateStub has to re-derive it. Pure: the declaration is data, and these
 * cases never reach a database.
 */

test("every declared statutory component resolves to its class", () => {
  for (const country of Object.keys(PAYROLL_COUNTRY_PACKS)) {
    for (const component of packStatutoryComponents(country)) {
      assert.equal(
        statutoryAssessment(country, component.systemKey, component.kind),
        component.assessedOn,
        `${country}/${component.code}`,
      );
    }
  }
});

test("income tax and FIT are the only income-assessed lines in either pack", () => {
  const incomeAssessed = Object.keys(PAYROLL_COUNTRY_PACKS).flatMap((country) =>
    packStatutoryComponents(country)
      .filter((component) => component.assessedOn === "taxable_income")
      .map((component) => `${country}/${component.code}`));
  assert.deepEqual(incomeAssessed, ["CA/TAX", "US/FIT"]);
});

test("employee CPP, CPP2, EI and QPIP are earnings-assessed, like the employer share", () => {
  // T4127 computes C and C2 from pensionable income and EI/QPIP from insurable
  // earnings; no factor-F / F2 / U1 deduction enters those formulas, so a
  // capped pre-tax support order cannot move them.
  for (const [systemKey, kind] of [
    ["cpp", "deduction"], ["cpp2", "deduction"], ["ei", "deduction"], ["qpip", "deduction"],
    ["cpp", "employer_contribution"], ["ei", "employer_contribution"],
    ["qpip", "employer_contribution"], ["wcb", "employer_contribution"],
    ["eht", "employer_contribution"],
  ] as const) {
    assert.equal(statutoryAssessment("CA", systemKey, kind), "earnings", `${systemKey}/${kind}`);
  }
  for (const [systemKey, kind] of [
    ["ss", "deduction"], ["medicare", "deduction"], ["medicare_addl", "deduction"],
    ["ss", "employer_contribution"], ["medicare", "employer_contribution"],
    ["futa", "employer_contribution"], ["suta", "employer_contribution"],
  ] as const) {
    assert.equal(statutoryAssessment("US", systemKey, kind), "earnings", `${systemKey}/${kind}`);
  }
});

test("an undeclared levy stops the run rather than defaulting to a class", () => {
  // The next pack's employer levy — UK secondary NI, an AU payroll tax, another
  // state unemployment scheme — must state its class before it can be pushed.
  assert.throws(
    () => statutoryAssessment("CA", "uk_secondary_ni", "employer_contribution"),
    (error: Error) => {
      assert.ok(error instanceof PayrollPackError);
      assert.match(error.message, /does not declare what uk_secondary_ni/);
      assert.match(error.message, /assessedOn/);
      return true;
    },
  );
  assert.throws(() => packStatutoryComponents("GB"), PayrollPackError);
});

test("a pack's component codes are unique, so a slot account cannot be ambiguous", () => {
  for (const country of Object.keys(PAYROLL_COUNTRY_PACKS)) {
    const codes = packStatutoryComponents(country).map((component) => component.code);
    assert.equal(new Set(codes).size, codes.length, country);
  }
});

test("a protection pass re-derives the declared income-assessed lines and nothing else", () => {
  // The pipeline's rule, driven by the real CA declaration: a pre-tax support
  // order changes tax, so tax is dropped and recomputed; CPP, EI and the WCB
  // premium are assessed on earnings and stand from the first pass.
  const line = (component: string, systemKey: string,
                kind: "deduction" | "employer_contribution", amount: string,
                projectId: string | null = null) => ({
    component, amount, projectId,
    assessedOn: statutoryAssessment("CA", systemKey, kind) as PayrollAssessedOn,
  });
  const firstPass = () => [
    line("WCB/WSIB", "wcb", "employer_contribution", "18.00", "job-a"),
    line("WCB/WSIB", "wcb", "employer_contribution", "12.01", "job-b"),
    line("Income tax", "income_tax", "deduction", "310.55"),
    line("CPP", "cpp", "deduction", "142.66"),
    line("EI", "ei", "deduction", "38.40"),
  ];

  const first = firstPass();
  const lines = firstPass();
  dropIncomeAssessedLines(lines);
  assert.deepEqual(
    lines.map((l) => l.component),
    ["WCB/WSIB", "WCB/WSIB", "CPP", "EI"],
    "only the income-assessed line is dropped",
  );
  lines.push(line("Income tax", "income_tax", "deduction", "347.12"));

  const earnings = (
    set: readonly { component: string; amount: string; projectId: string | null; assessedOn: PayrollAssessedOn }[],
  ) => set.filter((l) => l.assessedOn === "earnings");
  assertEarningsAssessedStable("Terry Worker", earnings(first), earnings(lines));
  assert.notEqual(
    lines.find((l) => l.component === "Income tax")!.amount,
    first.find((l) => l.component === "Income tax")!.amount,
  );
});
