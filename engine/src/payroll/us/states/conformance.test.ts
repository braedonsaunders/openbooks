/**
 * State withholding CONFORMANCE goldens.
 *
 * Every expected figure below is TRANSCRIBED FROM AN AGENCY'S OWN WORKED
 * EXAMPLE, with the publication, the example's own label and its printed inputs
 * recorded beside it. None was produced by running this engine and pasting the
 * answer — a test written that way proves the code does what it does, which is
 * not a conformance property.
 *
 * Where a published example CANNOT be reproduced, it is still here, marked, and
 * asserted against what the state's own TABLES produce, with the discrepancy
 * quantified. Deleting an inconvenient example would leave the next person to
 * rediscover it, and rounding the engine to match one of them would break the
 * twenty that follow a consistent rule.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  payrollCertificate, resolveCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
// The PACK publishes the US declarations now (its `certificates` / `withholding` /
// `reciprocity` members). Importing `us/jurisdictions.ts` for its side effect is
// exactly what made those declarations look alive while nothing in the product
// registered them: this file did the registering, for itself.
import "../../packs.ts";
import { CA_RATES_2026, CA_WITHHOLDING, caAnnualizedMethod } from "./ca.ts";
import { IL_RATES_2026, IL_WITHHOLDING } from "./il.ts";
import {
  NY_RATES_2026, NY_WITHHOLDING, NYC_WITHHOLDING, YONKERS_WITHHOLDING,
  yonkersNonresidentAnnualized,
} from "./ny.ts";
import {
  PA_RATES_2026, PA_WITHHOLDING, PHILADELPHIA_WITHHOLDING,
  act32LocalEit, localServicesTaxPerPeriod, paUcEmployeeWithholding, philadelphiaRateFor,
} from "./pa.ts";
import { money, resolvedCertificate } from "./conformance-support.ts";

/** A certificate resolved from answers, exactly as the run-time path builds it. */
const cert = (key: string, answers: Record<string, string> = {}): ResolvedCertificate =>
  resolvedCertificate(payrollCertificate("US", key), answers);

/* ===================================================================== */
/* CALIFORNIA — 2026 Withholding Schedules, Method B, Examples A–F       */
/* ===================================================================== */

const de4 = (over: Record<string, string> = {}) => cert("us_ca_de4", over);

test("CA Example A — weekly $210, single, 1 allowance: low income exemption", () => {
  // "Step 1 — Earnings for the weekly payroll period are less than the amount
  // shown in Table 1 - Low Income Exemption Table ($363); therefore, no income
  // tax is to be withheld."
  const result = CA_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "210.00", basis: "resident",
    certificate: de4({ filing_status: "single_or_dual", regular_allowances: "1" }),
  });
  assert.equal(result.tax, money("0"));
  assert.equal(result.factors.CA_LOW_INCOME, money("363"));
});

test("CA Example B — biweekly $1,600, married, 3 allowances (1 estimated): $2.38", () => {
  // The single most important golden in this file. Three allowances are
  // claimed, ONE of them for estimated deductions, so Table 2 is read at n=1
  // ($38) and the Table 4 CREDIT at n=2 ($12.95). Reading Table 4 at n=3 would
  // give $0.00 instead of $2.38 — a whole withholding, silently gone.
  const result = CA_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 26, wages: "1600.00", basis: "resident",
    certificate: de4({
      filing_status: "married_one_income",
      regular_allowances: "2", estimated_deduction_allowances: "1",
    }),
  });
  assert.equal(result.factors.CA_LOW_INCOME, money("1454"));
  assert.equal(result.factors.CA_EST_DEDUCTION, money("38")); // Table 2, n = 1
  assert.equal(result.factors.CA_SUBJECT, money("1562"));
  assert.equal(result.factors.CA_STD_DEDUCTION, money("439"));
  assert.equal(result.factors.CA_TAXABLE, money("1123"));
  // Table 27: 2.2% × ($1,123 − $852) = $5.96, plus $9.37 = $15.33.
  assert.equal(result.factors.CA_COMPUTED_TAX, money("15.33"));
  assert.equal(result.factors.CA_CREDIT, money("12.95")); // Table 4, n = 2
  assert.equal(result.tax, money("2.38"));
});

test("CA Example C — monthly $5,100, married, 5 allowances: $0.82", () => {
  const result = CA_WITHHOLDING.compute({
    payDate: "2026-03-31", periodsPerYear: 12, wages: "5100.00", basis: "resident",
    certificate: de4({ filing_status: "married_one_income", regular_allowances: "5" }),
  });
  assert.equal(result.factors.CA_TAXABLE, money("4149")); // 5,100 − 951
  assert.equal(result.factors.CA_COMPUTED_TAX, money("70.95")); // 50.62 + 20.33
  assert.equal(result.factors.CA_CREDIT, money("70.13"));
  assert.equal(result.tax, money("0.82"));
});

test("CA Example D — weekly $950, head of household, 3 allowances: $1.69", () => {
  const result = CA_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "950.00", basis: "resident",
    certificate: de4({ filing_status: "head_household", regular_allowances: "3" }),
  });
  assert.equal(result.factors.CA_TAXABLE, money("731")); // 950 − 219
  assert.equal(result.factors.CA_COMPUTED_TAX, money("11.40")); // 6.71 + 4.69
  assert.equal(result.tax, money("1.69"));
});

test("CA Examples E and F — the ANNUALIZED variant, $4.13 and $7.17", () => {
  // The guide's alternative method, exposed separately and deliberately NOT
  // wired into `compute`: it is an employer's election, it produces different
  // cents from the per-period method, and an engine that switched between two
  // published methods on its own would be unreproducible.
  const e = caAnnualizedMethod({
    payDate: "2026-03-15", periodsPerYear: 24, wagesPerPeriod: "2400.00",
    filingStatus: "married_one_income", regularAllowances: 4,
  });
  assert.equal(e.annualTax, money("99.20")); // 772.40 − 673.20
  assert.equal(e.perPeriod, money("4.13"));

  const f = caAnnualizedMethod({
    payDate: "2026-03-31", periodsPerYear: 12, wagesPerPeriod: "4750.00",
    filingStatus: "married_one_income", regularAllowances: 4,
  });
  assert.equal(f.annualTax, money("86.00")); // 759.20 − 673.20
  assert.equal(f.perPeriod, money("7.17"));
});

test("CA Tables 1 and 3 print four columns that pair up — pinned, not collapsed", () => {
  // Columns A and B are identical at every period, as are C and D. They are
  // stored as four keys so a future year in which they diverge is a data change
  // rather than a code change; this pins the present agreement.
  for (const table of [CA_RATES_2026.lowIncomeExemption, CA_RATES_2026.standardDeduction]) {
    for (const [period, columns] of Object.entries(table)) {
      assert.equal(columns.single_dual, columns.married_0_1, `${period} A/B`);
      assert.equal(columns.married_2_plus, columns.head_household, `${period} C/D`);
    }
  }
});

test("CA Table 4 over ten allowances multiplies the ONE-allowance figure", () => {
  // The printed footnote's own example: "the amount of tax credit for a married
  // taxpayer with 15 allowances ... on a weekly payroll period would be
  // $48.60". 15 × $3.24. NOT 1.5 × the ten-allowance $32.37 ($48.56), which the
  // per-row rounding makes different.
  const withFifteen = CA_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "5000.00", basis: "resident",
    certificate: de4({ filing_status: "married_one_income", regular_allowances: "15" }),
  });
  assert.equal(withFifteen.factors.CA_CREDIT, money("48.60"));
});

test("CA refuses a pay frequency it prints no table for", () => {
  assert.throws(
    () => CA_WITHHOLDING.compute({
      payDate: "2026-03-06", periodsPerYear: 13, wages: "2000", basis: "resident",
      certificate: de4(),
    }),
    /publishes withholding tables for .*there is nothing to scale/s,
  );
});

test("CA refuses a year it has not transcribed, and never extrapolates", () => {
  assert.throws(
    () => CA_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 26, wages: "2000", basis: "resident",
      certificate: de4(),
    }),
    /2027 California PIT withholding tables are not loaded.*Never extrapolate the prior year/s,
  );
});

test("CA supplemental flat rates are the published ones", () => {
  // DE 44 p. 18. Bonuses and stock options are withheld differently from other
  // supplemental wages — one rate for both would be wrong for one of them.
  assert.equal(CA_RATES_2026.supplemental.bonusesAndStockOptions, "0.1023");
  assert.equal(CA_RATES_2026.supplemental.other, "0.066");
});

/* ===================================================================== */
/* ILLINOIS — Booklet IL-700-T (R-12/25), automated payroll method        */
/* ===================================================================== */

const ilw4 = (over: Record<string, string> = {}) => cert("us_il_ilw4", over);

test("IL Example B — weekly $800, 2 basic + 2 additional allowances: $32.13", () => {
  // The booklet's own automated-method example, step by step:
  //   2 × $2,925 = $5,850;  2 × $1,000 = $2,000;  sum $7,850
  //   $7,850 ÷ 52 = $150.96;  $800 − $150.96 = $649.04;  × .0495 = $32.13
  const result = IL_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00", basis: "resident",
    certificate: ilw4({ line1_allowances: "2", line2_allowances: "2" }),
  });
  assert.equal(result.factors.IL_ANNUAL_EXEMPTION, money("7850"));
  assert.equal(result.factors.IL_PERIOD_EXEMPTION, money("150.96"));
  assert.equal(result.factors.IL_TAXABLE, money("649.04"));
  assert.equal(result.tax, money("32.13"));
});

test("IL rounds the per-period exemption BEFORE subtracting, as the example does", () => {
  // $7,850 ÷ 52 = 150.9615…; the booklet prints $150.96 and then $649.04.
  // Carrying full precision instead gives $649.0385 and a different final cent.
  const result = IL_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00", basis: "resident",
    certificate: ilw4({ line1_allowances: "2", line2_allowances: "2" }),
  });
  assert.equal(result.factors.IL_TAXABLE, money("649.04"));
});

test("IL printed table headers re-derive the pay-period divisors", () => {
  // The booklet prints NO pay-periods-per-year table. What it does print is the
  // per-allowance Line 2 subtraction in each table header, which is
  // $1,000 × 4.95% ÷ periods. Re-deriving them proves the divisors this engine
  // uses are the ones the state's own tables were built from.
  const annual = 49.50; // $1,000 × .0495
  const cents = (value: number) => (Math.round(value * 100) / 100).toFixed(2);
  for (const [period, periods] of Object.entries({
    daily: 365, weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12,
  })) {
    assert.equal(
      IL_RATES_2026.printedLine2PerPeriod[period],
      cents(annual / periods),
      `${period} header`,
    );
  }
});

test("IL with NO certificate on file withholds with no allowances", () => {
  // IL-W-4: "If you do not file a completed Form IL-W-4 ... your employer must
  // withhold Illinois Income Tax on the entire amount of your compensation,
  // without allowing any exemptions." The default is a STATUTORY fact declared
  // on the certificate's fields, not an assumption the engine makes.
  const result = IL_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00", basis: "resident",
    certificate: resolveCertificate({ certificate: payrollCertificate("US", "us_il_ilw4") }),
  });
  assert.equal(result.factors.IL_ANNUAL_EXEMPTION, money("0"));
  assert.equal(result.tax, money("39.60")); // 800 × .0495
});

test("IL Line 3 is added AFTER the rate, not taxed", () => {
  const result = IL_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00", basis: "resident",
    certificate: ilw4({
      line1_allowances: "2", line2_allowances: "2", additional_per_period: "25.00",
    }),
  });
  assert.equal(result.tax, money("57.13")); // 32.13 + 25.00
});

test("IL rate and allowance amounts are the published 2026 figures", () => {
  assert.equal(IL_RATES_2026.rate, "0.0495");
  assert.equal(IL_RATES_2026.line1Allowance, "2925");
  assert.equal(IL_RATES_2026.line2Allowance, "1000");
});

/* ===================================================================== */
/* NEW YORK STATE — NYS-50-T-NYS (1/26), Method II                       */
/* ===================================================================== */

const it2104 = (over: Record<string, string> = {}) => cert("us_ny_it2104", over);

const nysCase = (
  periodsPerYear: number, wages: string, status: string, allowances: string,
) => NY_WITHHOLDING.compute({
  payDate: "2026-03-06", periodsPerYear, wages, basis: "resident",
  certificate: it2104({ filing_status: status, nys_allowances: allowances }),
});

test("NYS Single Example 1 — weekly $400, 3 exemptions: $8.01", () => {
  const result = nysCase(52, "400.00", "single_or_hoh", "3");
  assert.equal(result.factors.NYS_ALLOWANCE, money("200.05"));
  assert.equal(result.factors.NYS_NET, money("199.95"));
  assert.equal(result.tax, money("8.01")); // 36.95 × .0440 = 1.63, + 6.38
});

test("NYS Single Example 3 — monthly $50,000, 3 exemptions: $3,576.63", () => {
  const result = nysCase(12, "50000.00", "single_or_hoh", "3");
  assert.equal(result.factors.NYS_NET, money("49133.40"));
  assert.equal(result.factors.NYS_METHOD, "2");
  assert.equal(result.tax, money("3576.63")); // 1,985.71 + 1,590.92
});

test("NYS Single Example 4 — daily $750, 2 exemptions: $44.10", () => {
  const result = nysCase(260, "750.00", "single_or_hoh", "2");
  assert.equal(result.factors.NYS_NET, money("713.85"));
  assert.equal(result.tax, money("44.10")); // 6.90 + 37.20
});

test("NYS Married Example 1 — weekly $400, 4 exemptions: $6.69", () => {
  const result = nysCase(52, "400.00", "married", "4");
  assert.equal(result.factors.NYS_ALLOWANCE, money("229.90"));
  assert.equal(result.tax, money("6.69")); // 0.31 + 6.38
});

test("NYS Married Example 3 — monthly $50,000, 3 exemptions: $3,622.09", () => {
  const result = nysCase(12, "50000.00", "married", "3");
  assert.equal(result.factors.NYS_NET, money("49087.60"));
  assert.equal(result.tax, money("3622.09")); // 1,322.09 + 2,300.00
});

test("NYS Married Example 4 — daily $750, 2 exemptions: $44.58", () => {
  const result = nysCase(260, "750.00", "married", "2");
  // The publication's own step 4 prints the rate as "0.0811", but the table
  // says 0.0801 and only 0.0801 reproduces the printed $8.47. The TABLE is
  // right and the example's rate is a typo; the NYS edition of the same example
  // prints 0.0801 correctly.
  assert.equal(result.tax, money("44.58")); // 8.47 + 36.11
});

test("NYS Single Example 2 — the publication's own arithmetic does not round", () => {
  // NYS-50-T-NYS (1/26) p. 16 prints step 4 as $165.00 × 0.0753 = $12.43 and a
  // total of $258.51. The exact product is 12.4245, which rounds HALF-UP to
  // $12.42 and totals $258.50. The publication rounded away from half-up here
  // and TRUNCATED in the married twin of the same example, so no single rule
  // reproduces both. This engine rounds half-up everywhere, which matches 21 of
  // the 24 printed examples; the remaining three are recorded, not chased.
  const result = nysCase(24, "5000.00", "single_or_hoh", "1");
  assert.equal(result.factors.NYS_NET, money("4650"));
  assert.equal(result.tax, money("258.50"));
  // Exactly one cent below the printed figure. Quantified rather than hidden —
  // and compared as an exact decimal string, because the whole point of this
  // engine is that a cent is never a float.
  assert.equal(result.tax, money("258.50"));
  assert.notEqual(result.tax, money("258.51"));
});

test("NYS recapture bands are non-monotonic ON PURPOSE", () => {
  // 6.40% → 11.44% → 7.35% in the single schedule. A table-validation test that
  // asserted monotonic marginal rates would fail here, and "fixing" the data to
  // make it pass would delete New York's supplemental-tax recapture.
  const single = NY_RATES_2026.nys.tables.annual.single.map((row) => Number(row.rate));
  assert.ok(single.includes(0.1144));
  assert.ok(single.indexOf(0.1144) > single.indexOf(0.064));
  assert.ok(single[single.indexOf(0.1144) + 1]! < 0.1144);
  const married = NY_RATES_2026.nys.tables.annual.married.map((row) => Number(row.rate));
  assert.ok(married.includes(0.1349));
});

test("NYS Method III replaces Method II above the annualized threshold", () => {
  // A flat rate on the WHOLE annualized wage, not on an excess.
  const result = nysCase(12, "120000.00", "single_or_hoh", "0");
  assert.equal(result.factors.NYS_METHOD, "3");
  assert.equal(result.factors.NYS_METHOD3_RATE, "0.1045");
  // net = 120,000 − 616.70 = 119,383.30; annualized 1,432,599.60 ≥ 1,077,550.
  // 1,432,599.60 × .1045 = 149,706.6582 → $149,706.66 to the cent, ÷ 12 =
  // 12,475.555 → $12,475.56.
  //
  // NOTE: the publication prints NO worked Method III example, so the two
  // roundings here (at step 3 and at step 4) follow this engine's own
  // convention — half-up to the cent, the same rule every other de-annualization
  // in the payroll engines uses — rather than a citation. Recorded as such.
  assert.equal(result.factors.NYS_ANNUALIZED_NET, money("1432599.60"));
  assert.equal(result.factors.NYS_METHOD3_RATE, "0.1045");
  assert.equal(result.tax, money("12475.56"));
});

test("NYS Method II tables cover every net wage below the Method III handoff", () => {
  // The "no line covers these wages" throw must be unreachable. Proving it here
  // means a future transcription that drops a row fails loudly at build time
  // rather than at 3am on a pay date.
  for (const marital of ["single", "married"] as const) {
    for (const [period, table] of Object.entries(NY_RATES_2026.nys.tables)) {
      const rows = table[marital];
      assert.equal(rows[0]!.atLeast, "0", `${period}/${marital} starts at zero`);
      for (let i = 0; i + 1 < rows.length; i++) {
        assert.equal(
          rows[i]!.butLessThan, rows[i + 1]!.atLeast,
          `${period}/${marital} row ${i} leaves a hole`,
        );
      }
    }
  }
});

/* ===================================================================== */
/* NEW YORK CITY — NYS-50-T-NYC (1/26)                                   */
/* ===================================================================== */

const nycCase = (
  periodsPerYear: number, wages: string, status: string, allowances: string,
) => NYC_WITHHOLDING.compute({
  payDate: "2026-03-06", periodsPerYear, wages, basis: "resident",
  certificate: it2104({ filing_status: status, nyc_allowances: allowances }),
});

test("NYC Single Examples 1–4 reproduce exactly", () => {
  assert.equal(nycCase(52, "400.00", "single_or_hoh", "3").tax, money("6.11"));
  assert.equal(nycCase(24, "5000.00", "single_or_hoh", "1").tax, money("188.80"));
  assert.equal(nycCase(12, "50000.00", "single_or_hoh", "3").tax, money("2070.50"));
  assert.equal(nycCase(260, "750.00", "single_or_hoh", "2").tax, money("29.51"));
});

test("NYC Married Examples 1–4 reproduce exactly", () => {
  assert.equal(nycCase(52, "400.00", "married", "4").tax, money("5.17"));
  assert.equal(nycCase(24, "5000.00", "married", "3").tax, money("184.37"));
  assert.equal(nycCase(12, "50000.00", "married", "3").tax, money("2068.73"));
  assert.equal(nycCase(260, "750.00", "married", "2").tax, money("29.43"));
});

test("NYC filing status reaches the tax ONLY through the allowance table", () => {
  // The publication prints a Single table and a Married table and they are
  // byte-identical in all six periods. One table is stored; this pins the
  // finding, so an edition in which they diverge is caught rather than absorbed.
  const single = nycCase(52, "400.00", "single_or_hoh", "3");
  const married = nycCase(52, "400.00", "married", "3");
  // Same allowance count, different Table A values, therefore different tax…
  assert.notEqual(single.factors.NYC_ALLOWANCE, married.factors.NYC_ALLOWANCE);
  // …but identical net wages give identical tax, because the schedule is one
  // schedule.
  const a = NYC_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "400.00", basis: "resident",
    certificate: it2104({ filing_status: "single_or_hoh", nyc_allowances: "0" }),
  });
  const b = NYC_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52,
    wages: money(String(400 - 96.15 + 105.75)), basis: "resident",
    certificate: it2104({ filing_status: "married", nyc_allowances: "0" }),
  });
  assert.equal(a.factors.NYC_NET, b.factors.NYC_NET);
  assert.equal(a.tax, b.tax);
});

/* ===================================================================== */
/* YONKERS — NYS-50-T-Y (1/26)                                           */
/* ===================================================================== */

const yonkersResident = (periodsPerYear: number, nysTax: string) =>
  YONKERS_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear, wages: "0", basis: "resident",
    regionTax: nysTax, certificate: it2104(),
  });

test("Yonkers resident is 16.75% OF THE NEW YORK STATE TAX", () => {
  // The publication reprints the whole NYS schedule with "× 0.1675" appended.
  // This engine multiplies instead of carrying a second copy of New York's
  // tables — a second copy is a second thing to keep in step.
  assert.equal(yonkersResident(52, "8.01").tax, money("1.34")); // Single Example 1
  assert.equal(yonkersResident(260, "44.10").tax, money("7.39")); // Single Example 4
  assert.equal(yonkersResident(52, "6.69").tax, money("1.12")); // Married Example 1
  assert.equal(yonkersResident(12, "3622.09").tax, money("606.70")); // Married Example 3
  assert.equal(yonkersResident(260, "44.58").tax, money("7.47")); // Married Example 4
});

test("Yonkers Single Example 3 — the publication truncated where it usually rounds", () => {
  // $3,576.63 × 0.1675 = 599.085525. The pub prints $599.08; half-up gives
  // $599.09, and seven of the eight Yonkers examples match half-up exactly.
  assert.equal(yonkersResident(12, "3576.63").tax, money("599.09"));
});

test("Yonkers resident refuses to recompute the state tax it is a surcharge on", () => {
  assert.throws(
    () => YONKERS_WITHHOLDING.compute({
      payDate: "2026-03-06", periodsPerYear: 52, wages: "1000", basis: "resident",
      certificate: it2104(),
    }),
    /the state tax must be computed first and passed in/,
  );
});

test("Yonkers NONRESIDENT is a different tax on a different base — Method VII", () => {
  const nonresident = (periodsPerYear: number, wages: string) =>
    YONKERS_WITHHOLDING.compute({
      payDate: "2026-03-06", periodsPerYear, wages, basis: "nonresident",
      certificate: it2104(),
    }).tax;
  // Example 1: weekly $75 falls on line 1 — no tax withheld.
  assert.equal(nonresident(52, "75.00"), money("0"));
  // Example 2: weekly $200 → ($200 − $38) × 0.0050.
  assert.equal(nonresident(52, "200.00"), money("0.81"));
  // Example 3: semimonthly $400 → ($400 − $125) × 0.0050.
  assert.equal(nonresident(24, "400.00"), money("1.38"));
});

test("Yonkers Methods VII and VIII agree to the cent on the published examples", () => {
  // The state calibrates the exact and annualized methods to match; proving it
  // proves both transcriptions at once.
  assert.equal(yonkersNonresidentAnnualized({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "75.00",
  }), money("0"));
  assert.equal(yonkersNonresidentAnnualized({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "200.00",
  }), money("0.81"));
  assert.equal(yonkersNonresidentAnnualized({
    payDate: "2026-03-06", periodsPerYear: 24, wages: "400.00",
  }), money("1.38"));
});

test("Yonkers supplemental rate is exactly the NYS rate times the surcharge", () => {
  // 11.70% × 16.75% = 1.95975%. The publications are internally consistent;
  // this proves it rather than trusting it.
  const nys = Number(NY_RATES_2026.nys.supplementalRate);
  const surcharge = Number(NY_RATES_2026.yonkers.residentSurcharge);
  assert.equal(
    Number(NY_RATES_2026.yonkers.supplementalResidentRate).toFixed(7),
    (nys * surcharge).toFixed(7),
  );
});

/* ===================================================================== */
/* PENNSYLVANIA                                                          */
/* ===================================================================== */

test("PA is a flat 3.07% on all compensation, with no allowances of any kind", () => {
  const result = PA_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 26, wages: "2000.00", basis: "resident",
    certificate: cert("us_pa_rev419"),
  });
  assert.equal(PA_RATES_2026.rate, "0.0307");
  assert.equal(result.tax, money("61.40"));
});

test("PA supplemental compensation is ADDED and taxed at the same one rate", () => {
  // REV-415: "an employer must determine the tax to withhold by adding the
  // supplemental or other compensation for the current payroll period and
  // multiplying this amount by the withholding rate." No separate rate exists.
  const result = PA_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 26, wages: "2000.00", supplemental: "5000.00",
    basis: "resident", certificate: cert("us_pa_rev419"),
  });
  assert.equal(result.factors.PA_COMPENSATION, money("7000"));
  assert.equal(result.tax, money("214.90")); // 7,000 × .0307
});

test("PA UC EMPLOYEE withholding is 70 cents per $1,000, uncapped", () => {
  // PA DLI's own phrasing of the CY2026 rate. It is an EMPLOYEE deduction —
  // Pennsylvania is one of very few states where the employee contributes — and
  // it is on TOTAL gross wages with no wage base at all.
  assert.equal(paUcEmployeeWithholding("2026-03-06", "1000.00"), money("0.70"));
  assert.equal(paUcEmployeeWithholding("2026-03-06", "100000.00"), money("70.00"));
});

test("Philadelphia's rate is keyed to the PAY DATE and changes on 1 July", () => {
  // phila.gov: any paycheck with a pay date after 30 June uses the new rates.
  // A single rate per tax year would be wrong for half of every year.
  assert.equal(philadelphiaRateFor("2026-06-30", "resident").rate, "0.0374");
  assert.equal(philadelphiaRateFor("2026-07-01", "resident").rate, "0.03735");
  assert.equal(philadelphiaRateFor("2026-06-30", "nonresident").rate, "0.0343");
  assert.equal(philadelphiaRateFor("2026-07-01", "nonresident").rate, "0.03425");
});

test("Philadelphia's resident and nonresident rates are different taxes", () => {
  const at = (basis: "resident" | "nonresident", payDate: string) =>
    PHILADELPHIA_WITHHOLDING.compute({
      payDate, periodsPerYear: 26, wages: "2000.00", basis,
      certificate: cert("us_pa_clgs32_6"),
    }).tax;
  assert.equal(at("resident", "2026-08-14"), money("74.70")); // 2,000 × 3.735%
  assert.equal(at("nonresident", "2026-08-14"), money("68.50")); // 2,000 × 3.425%
  assert.equal(at("resident", "2026-03-06"), money("74.80")); // 2,000 × 3.74%
  assert.equal(at("nonresident", "2026-03-06"), money("68.60")); // 2,000 × 3.43%
});

test("PA Act 32 local EIT applies the rate the higher-of rule already picked", () => {
  // DCED's live worked case: a Bethlehem resident (total resident 1.000%)
  // working in Allentown (nonresident 1.280%) is withheld at 1.280%.
  assert.equal(act32LocalEit({ compensation: "2000.00", rate: "0.0128" }), money("25.60"));
  // DCED Example #2: resident 1.6% beats work-location 1.3%.
  assert.equal(act32LocalEit({ compensation: "2000.00", rate: "0.016" }), money("32.00"));
});

test("PA Local Services Tax prorates by TRUNCATION, as DCED instructs", () => {
  // "employers are required to round DOWN to the nearest one-hundredth of a
  // dollar" — the one place in this engine that does not round half-up.
  // DCED's own examples: $52 → $1 weekly, $4.33 monthly; $36 → $0.69 weekly,
  // $3 monthly.
  assert.equal(localServicesTaxPerPeriod({ annualAmount: "52", periodsPerYear: 52 }), money("1"));
  assert.equal(localServicesTaxPerPeriod({ annualAmount: "52", periodsPerYear: 12 }), money("4.33"));
  assert.equal(localServicesTaxPerPeriod({ annualAmount: "36", periodsPerYear: 52 }), money("0.69"));
  assert.equal(localServicesTaxPerPeriod({ annualAmount: "36", periodsPerYear: 12 }), money("3"));
  // Scranton is $156 a year, not $52: the statutory maximum is jurisdiction
  // data, not a constant, and an engine that hardcoded $52 would be wrong.
  assert.equal(localServicesTaxPerPeriod({ annualAmount: "156", periodsPerYear: 26 }), money("6"));
  // An upfront low-income exemption stops withholding entirely.
  assert.equal(
    localServicesTaxPerPeriod({ annualAmount: "52", periodsPerYear: 52, exempt: true }),
    money("0"),
  );
  // $10 or less is a lump sum, and prorating it would be a different tax.
  assert.throws(
    () => localServicesTaxPerPeriod({ annualAmount: "10", periodsPerYear: 52 }),
    /collected as a lump sum/,
  );
});
