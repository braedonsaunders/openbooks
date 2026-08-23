/**
 * Iowa withholding CONFORMANCE goldens.
 *
 * Every expected figure is transcribed from the Iowa Withholding Formula For
 * Taxable Wages Paid Beginning January 1, 2026 (Released November 2025),
 * Examples 1–10. Nothing here was produced by running the engine and pasting
 * the answer.
 *
 * Iowa withholds at a single 3.80% rate in 2026. The pre-2023 bracket table
 * is not this formula.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  certificateDeclarationProblem, resolveCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
import "../../packs.ts";
import {
  IA_44016, IA_CERTIFICATE, IA_REGION, IA_RATES_2026, IA_WITHHOLDING, iaColumn2024,
} from "./ia.ts";
import { pctToRate } from "./transcription.ts";
import { money, resolvedCertificate } from "./conformance-support.ts";

const cert = (answers: Record<string, string> = {}): ResolvedCertificate =>
  resolvedCertificate(IA_CERTIFICATE, answers);

test("IA certificate and region declarations are well formed", () => {
  assert.equal(certificateDeclarationProblem(IA_CERTIFICATE), null);
  assert.equal(certificateDeclarationProblem(IA_44016), null);
  assert.equal(IA_REGION.implemented, true);
  assert.equal(IA_REGION.certificateKey, "us_ia_iaw4");
});

test("IA Example 1 — biweekly $2,100, Other, $40 allowance: $59.26", () => {
  // T1 = $2,100.00 − $500.00 = $1,600.00
  // T2 = $1,600.00 × 3.80% = $60.80
  // T3 = $60.80 − $40.00 / 26 = $59.26
  // T4 = $59.26
  const result = IA_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 26, wages: "2100.00", basis: "resident",
    certificate: cert({ filing_status: "other", total_allowance: "40" }),
  });
  assert.equal(result.factors.IA_COLUMN, "A");
  assert.equal(result.factors.IA_DEDUCTION, money("500.00"));
  assert.equal(result.factors.IA_T1, money("1600"));
  assert.equal(result.factors.IA_T2, money("60.80"));
  assert.equal(result.factors.IA_T3, money("59.26"));
  assert.equal(result.tax, money("59.26"));
});

test("IA Example 2 — biweekly $2,100, MFJ spouse no earned income, $80: $38.72", () => {
  // T1 = $2,100.00 − $1,000.00 = $1,100.00
  // T2 = $41.80; T3 = $41.80 − $80 / 26 = $38.72
  const result = IA_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 26, wages: "2100.00", basis: "resident",
    certificate: cert({
      filing_status: "married_joint", total_allowance: "80",
    }),
  });
  assert.equal(result.factors.IA_COLUMN, "C");
  assert.equal(result.factors.IA_DEDUCTION, money("1000.00"));
  assert.equal(result.factors.IA_T2, money("41.80"));
  assert.equal(result.tax, money("38.72"));
});

test("IA Example 3 — biweekly $2,100, Head of Household, $160: $45.15", () => {
  // T1 = $2,100.00 − $750.00 = $1,350.00; T2 = $51.30
  // T3 = $51.30 − $160 / 26 = $45.15
  const result = IA_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 26, wages: "2100.00", basis: "resident",
    certificate: cert({ filing_status: "head_household", total_allowance: "160" }),
  });
  assert.equal(result.factors.IA_COLUMN, "B");
  assert.equal(result.factors.IA_DEDUCTION, money("750.00"));
  assert.equal(result.tax, money("45.15"));
});

test("IA Examples 4–6 — monthly $5,000 at each 2026 status", () => {
  // Example 4 Other $40: T1 $3,916.67; T2 $148.83; T3 $145.50
  const other = IA_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 12, wages: "5000.00", basis: "resident",
    certificate: cert({ filing_status: "other", total_allowance: "40" }),
  });
  assert.equal(other.factors.IA_T1, money("3916.67"));
  assert.equal(other.factors.IA_T2, money("148.83"));
  assert.equal(other.tax, money("145.50"));

  // Example 5 MFJ spouse no income $80: T1 $2,833.33; T2 $107.67; T3 $101.00
  const joint = IA_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 12, wages: "5000.00", basis: "resident",
    certificate: cert({ filing_status: "married_joint", total_allowance: "80" }),
  });
  assert.equal(joint.factors.IA_T1, money("2833.33"));
  assert.equal(joint.factors.IA_T2, money("107.67"));
  assert.equal(joint.tax, money("101.00"));

  // Example 6 Head of Household $160: T1 $3,375.00; T2 $128.25; T3 $114.92
  const hoh = IA_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 12, wages: "5000.00", basis: "resident",
    certificate: cert({ filing_status: "head_household", total_allowance: "160" }),
  });
  assert.equal(hoh.factors.IA_T1, money("3375"));
  assert.equal(hoh.factors.IA_T2, money("128.25"));
  assert.equal(hoh.tax, money("114.92"));
});

test("IA Examples 7–10 — a 2023-or-earlier IA W-4 uses $40 per allowance", () => {
  // Example 7: biweekly $2,100, Single, 1 allowance → same $59.26 as Example 1.
  const e7 = IA_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 26, wages: "2100.00", basis: "resident",
    certificate: cert({
      pre_2024: "true", pre_2024_marital: "single", pre_2024_allowances: "1",
    }),
  });
  assert.equal(e7.factors.IA_FORM, "pre_2024");
  assert.equal(e7.factors.IA_COLUMN, "A");
  assert.equal(e7.tax, money("59.26"));

  // Example 8: biweekly $2,100, Married, 2 allowances → $38.72
  const e8 = IA_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 26, wages: "2100.00", basis: "resident",
    certificate: cert({
      pre_2024: "true", pre_2024_marital: "married", pre_2024_allowances: "2",
    }),
  });
  assert.equal(e8.tax, money("38.72"));

  // Example 9: monthly $5,000, Single, 1 allowance → $145.50
  const e9 = IA_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 12, wages: "5000.00", basis: "resident",
    certificate: cert({
      pre_2024: "true", pre_2024_marital: "single", pre_2024_allowances: "1",
    }),
  });
  assert.equal(e9.tax, money("145.50"));

  // Example 10: monthly $5,000, Married, 2 allowances → $101.00
  const e10 = IA_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 12, wages: "5000.00", basis: "resident",
    certificate: cert({
      pre_2024: "true", pre_2024_marital: "married", pre_2024_allowances: "2",
    }),
  });
  assert.equal(e10.tax, money("101.00"));
});

test("IA two-earner joint uses column A; no IA W-4 uses column A and W = $0", () => {
  // Booklet footnote: MFJ + spouse earned income Yes → column (A).
  assert.equal(iaColumn2024("married_joint", true), "A");
  assert.equal(iaColumn2024("married_joint", false), "C");
  assert.equal(iaColumn2024(null, false), "A");
  assert.equal(IA_RATES_2026.rate, pctToRate("3.80"));

  const twoEarner = IA_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 26, wages: "2100.00", basis: "resident",
    certificate: cert({
      filing_status: "married_joint", spouse_earned_income: "true", total_allowance: "40",
    }),
  });
  assert.equal(twoEarner.factors.IA_COLUMN, "A");
  assert.equal(twoEarner.tax, money("59.26"));

  // IAC 701—307.3: no certificate → no allowances. Booklet: missing status → (A).
  const none = IA_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 26, wages: "2100.00", basis: "resident",
    certificate: resolveCertificate({ certificate: IA_CERTIFICATE }),
  });
  assert.equal(none.factors.IA_COLUMN, "A");
  assert.equal(none.factors.IA_ALLOWANCE_ANNUAL, money("0"));
  assert.equal(none.tax, money("60.80")); // T2 with W = 0
});

test("IA line 8 is added AFTER the rate; an unlisted frequency annualizes", () => {
  const extra = IA_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 26, wages: "2100.00", basis: "resident",
    certificate: cert({
      filing_status: "other", total_allowance: "40", additional_per_period: "15.00",
    }),
  });
  assert.equal(extra.tax, money("74.26"));

  // "Pay period not provided": quarterly uses the annual D, then ÷ 4.
  // Annual wages $8,400 × 4 = $33,600; D $13,000; T1 $20,600; T2 $782.80;
  // T3 $782.80 − $40; ÷ 4.
  const quarterly = IA_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 4, wages: "8400.00", basis: "resident",
    certificate: cert({ filing_status: "other", total_allowance: "40" }),
  });
  assert.equal(quarterly.factors.IA_PERIOD, "annualized/4");
  assert.equal(quarterly.factors.IA_DEDUCTION, money("13000.00"));
  assert.equal(quarterly.factors.IA_T1, money("20600"));
  assert.equal(quarterly.factors.IA_T2, money("782.80"));
  assert.equal(quarterly.tax, money("185.70")); // (782.80 − 40) ÷ 4

  const exempt = IA_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 26, wages: "2100.00", basis: "resident",
    certificate: cert({ exempt: "true" }),
  });
  assert.equal(exempt.tax, money("0"));
});

test("IA refuses a year it has not transcribed", () => {
  assert.throws(
    () => IA_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 26, wages: "2100", basis: "resident",
      certificate: cert(),
    }),
    /2027 Iowa income tax withholding tables are not loaded.*Never extrapolate the prior year/s,
  );
});
