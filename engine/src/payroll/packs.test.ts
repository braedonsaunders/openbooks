import assert from "node:assert/strict";
import test from "node:test";
import {
  assertEarningsAssessedStable,
  dropIncomeAssessedLines,
} from "../payroll-limits.ts";
import {
  PAYROLL_COUNTRY_PACKS,
  PayrollPackError,
  employmentJurisdictionsOf,
  jurisdictionKey,
  labourJurisdictionProblem,
  packStatutoryComponents,
  payrollJurisdictionDeclared,
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

test("the income taxes are the only income-assessed lines in either pack", () => {
  // Federal income tax (T4127 factor T), Québec income tax (TP-1015 variable
  // A) and US FIT are all computed from income net of pre-tax deductions, so
  // all three — and nothing else — are re-derived by the protection fixpoint.
  const incomeAssessed = Object.keys(PAYROLL_COUNTRY_PACKS).flatMap((country) =>
    packStatutoryComponents(country)
      .filter((component) => component.assessedOn === "taxable_income")
      .map((component) => `${country}/${component.code}`));
  assert.deepEqual(incomeAssessed, ["CA/TAX", "CA/QCTAX", "US/FIT"]);
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

// ---------------------------------------------------------------------------
// The labour jurisdiction: the employment attribute, validated against the
// pack declarations
// ---------------------------------------------------------------------------

/**
 * `jurisdictionKey` maps an employee to the employment-standards rules that
 * govern them. Deriving it from the work region alone is wrong for an employer
 * regulated by a different labour jurisdiction than the one its employees work
 * in: that jurisdiction has its own statutory holiday calendar AND its own
 * holiday-pay formula, so without an attribute for it the employment silently
 * inherited the region's answers.
 */

test("the region derivation is unchanged when no labour jurisdiction is set", () => {
  assert.equal(jurisdictionKey("CA", "ON"), "CA-ON");
  assert.equal(jurisdictionKey("US", "TX"), "US-TX");
  // No region at all still keys as the country — the pre-existing behaviour.
  assert.equal(jurisdictionKey("CA", null), "CA");
  assert.equal(jurisdictionKey("CA", ""), "CA");
  // Explicitly absent, in every shape the column and the API can produce.
  assert.equal(jurisdictionKey("CA", "ON", null), "CA-ON");
  assert.equal(jurisdictionKey("CA", "ON", ""), "CA-ON");
  assert.equal(jurisdictionKey("CA", "ON", "   "), "CA-ON");
});

test("an explicit labour jurisdiction wins over the region derivation", () => {
  // An employee working in Ontario for a federally regulated employer: the
  // Canada Labour Code governs the employment, the ESA does not.
  assert.equal(jurisdictionKey("CA", "ON", "CA"), "CA");
  // And it is honoured whatever the region, including Québec.
  assert.equal(jurisdictionKey("CA", "QC", "CA"), "CA");
  // A cross-province posting: the declared jurisdiction, not the work region.
  assert.equal(jurisdictionKey("CA", "AB", "CA-BC"), "CA-BC");
  assert.equal(jurisdictionKey("US", "TX", "US"), "US");
  // Case and whitespace are normalized, not rejected — the keys are uppercase.
  assert.equal(jurisdictionKey("CA", "ON", " ca-bc "), "CA-BC");
  // Whatever it resolves to, the packs must actually declare it: that is what
  // makes the holiday calendar resolvable rather than a guess.
  assert.ok(payrollJurisdictionDeclared(jurisdictionKey("CA", "ON", "CA")));
});

test("every declared employment jurisdiction is an acceptable labour jurisdiction", () => {
  for (const country of Object.keys(PAYROLL_COUNTRY_PACKS)) {
    for (const jurisdiction of employmentJurisdictionsOf(country)) {
      assert.equal(
        labourJurisdictionProblem(country, jurisdiction.key),
        null,
        `${country}/${jurisdiction.key}`,
      );
      // Accepting it means the holiday layer can resolve it.
      assert.ok(payrollJurisdictionDeclared(jurisdictionKey(country, "ON", jurisdiction.key)));
    }
  }
});

test("an empty labour jurisdiction is not a problem — it means derive from the region", () => {
  assert.equal(labourJurisdictionProblem("CA", null), null);
  assert.equal(labourJurisdictionProblem("CA", ""), null);
  assert.equal(labourJurisdictionProblem("CA", "  "), null);
});

test("an undeclared labour jurisdiction is refused BY NAME, listing what is declared", () => {
  // 'CA-ZZ' is the region an employee employed outside any province carries.
  // No employment-standards act governs it, and accepting it would let the
  // employment fall back on the work region's calendar — the exact
  // substitution the attribute exists to prevent.
  const problem = labourJurisdictionProblem("CA", "CA-ZZ");
  assert.ok(problem);
  assert.match(problem!, /CA-ZZ/, "names the refused value");
  assert.match(problem!, /no payroll pack declares/);
  assert.match(problem!, /CA-ON/, "lists what IS declared");

  // A typo is refused the same way.
  assert.match(labourJurisdictionProblem("CA", "CA-ONT")!, /CA-ONT/);
  assert.ok(labourJurisdictionProblem("CA", "ON"), "a region code is not a jurisdiction key");
});

test("a tax administration's own calendar is refused as a labour jurisdiction", () => {
  // CA-CRA is declared, and it is emphatically not an employment calendar: it
  // carries Easter Monday and the Civic Holiday, which no province's ESA lists,
  // and it exists to move remittance due dates.
  const problem = labourJurisdictionProblem("CA", "CA-CRA");
  assert.ok(problem);
  assert.match(problem!, /CA-CRA/);
  assert.match(problem!, /tax_administration/);
  assert.ok(labourJurisdictionProblem("CA", "CA-CRA-QC"));
});

test("another country's labour jurisdiction is refused", () => {
  // The employer of record does not sit in it, so it cannot govern.
  const problem = labourJurisdictionProblem("CA", "US-TX");
  assert.ok(problem);
  assert.match(problem!, /US-TX/);
  assert.match(problem!, /another country/);
  assert.ok(labourJurisdictionProblem("US", "CA-ON"));
});

test("a country no pack declares refuses rather than answering", () => {
  assert.throws(() => labourJurisdictionProblem("ZZ", "ZZ"), PayrollPackError);
});
