/**
 * Virginia withholding CONFORMANCE goldens.
 *
 * Every expected figure is transcribed from the Income Tax Withholding
 * Guide for Employers, Rev. 05/25, Formula Method (p. 21), or is the
 * formula's own arithmetic on its own printed numbers. Nothing here was
 * produced by running the engine and pasting the answer.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  certificateDeclarationProblem, resolveCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
import "../../packs.ts";
import { D, mulRateCents, U } from "../../canada/decimal.ts";
import { pctToRate } from "./transcription.ts";
import { VA_CERTIFICATE, VA_REGION } from "./va-declaration.ts";
import { VA_RATES_2026, VA_WITHHOLDING, vaSupplementalFlat } from "./va.ts";

const money = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${(fraction + "0000").slice(0, 4)}`;
};

function cert(answers: Record<string, string> = {}): ResolvedCertificate {
  return resolveCertificate({
    certificate: VA_CERTIFICATE,
    stored: [{ certificateKey: VA_CERTIFICATE.key, answers, effectiveFrom: null }],
  });
}

test("VA certificate and region declarations are well formed", () => {
  assert.equal(certificateDeclarationProblem(VA_CERTIFICATE), null);
  assert.equal(VA_REGION.implemented, true);
  assert.equal(VA_REGION.certificateKey, "us_va_va4");
});

test("VA p. 21 John example — semi-monthly $2,649, five personal exemptions", () => {
  // "John claims exemptions for himself, his spouse, and their three children
  //  for withholding tax purposes. He is paid on a semi-monthly basis, and his
  //  gross wages for this pay period were $2,649.
  //  1. ($2,649) × 24 − [$8,750 + ($930) × 5] = T
  //     $63,576 − $13,400 = $50,176
  //  2. T is over $17,000
  //     $720 + 5.75% of $33,176 = W
  //     $720 + $1,908 = $2,628
  //  3. $2,628 ÷ 24 = $109.50"
  //
  // The guide says the wage-bracket tables "are approximate" and to "use the
  // formula below for exact amounts." 5.75% of $33,176 is $1,907.62, not the
  // dollar-rounded $1,908 the example prints, so the formula to the cent gives
  // W = $2,627.62 and W/H = $109.48. The engine follows the formula.
  const result = VA_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 24, wages: "2649.00", basis: "resident",
    certificate: cert({ personal_exemptions: "5" }),
  });
  assert.equal(result.factors.VA_ANNUAL_WAGES, money("63576"));
  assert.equal(result.factors.VA_ANNUAL_EXEMPTION, money("13400"));
  assert.equal(result.factors.VA_TAXABLE, money("50176"));
  assert.equal(result.factors.VA_BAND_OVER, "17000");
  assert.equal(result.factors.VA_ANNUAL_TAX, money("2627.62"));
  assert.equal(result.tax, money("109.48"));
  assert.notEqual(result.tax, money("109.50"));
  // The example's own rounded line, pinned so a future editor can see the gap.
  assert.equal(D(U("720") + mulRateCents(U("33176"), "0.0575")), money("2627.62"));
  assert.equal(D(U("720") + U("1908")), money("2628"));
});

test("VA $8,750 / $930 / $800 / 5.75% are the publication's own figures", () => {
  assert.equal(VA_RATES_2026.standardDeduction, "8750");
  assert.equal(VA_RATES_2026.personalExemption, "930");
  assert.equal(VA_RATES_2026.ageBlindExemption, "800");
  assert.equal(VA_RATES_2026.formula[3]!.rate, pctToRate("5.75"));
  assert.notEqual(VA_RATES_2026.standardDeduction, "8500");
  // A pre-July-2025 $8,500 standard deduction would change John's T.
  assert.notEqual(
    D(U("63576") - U("8500") - U("930") * 5n),
    money("50176"),
  );
});

test("VA with no VA-4 withholds as if no exemptions", () => {
  // "If you do not file this form, your employer must withhold Virginia
  // income tax as if you had no exemptions."
  const result = VA_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 24, wages: "2649.00", basis: "resident",
    certificate: resolveCertificate({ certificate: VA_CERTIFICATE }),
  });
  // T = $63,576 − $8,750 = $54,826; W = $720 + 5.75% × $37,826.
  assert.equal(result.factors.VA_ANNUAL_EXEMPTION, money("8750"));
  assert.equal(result.factors.VA_TAXABLE, money("54826"));
  assert.notEqual(result.tax, money("109.48"));
});

test("VA extra withholding is added AFTER the formula", () => {
  const result = VA_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 24, wages: "2649.00", basis: "resident",
    certificate: cert({ personal_exemptions: "5", additional_per_period: "10.00" }),
  });
  assert.equal(result.tax, money("119.48"));
});

test("VA-4 lines 3 and 4 stop withholding", () => {
  assert.equal(VA_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 24, wages: "2649.00", basis: "resident",
    certificate: cert({ exempt: "true" }),
  }).tax, money("0"));
  assert.equal(VA_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 24, wages: "2649.00", basis: "resident",
    certificate: cert({ military_spouse_exempt: "true" }),
  }).tax, money("0"));
});

test("VA flat supplemental 5.75% is the separately-paid election, not compute", () => {
  // Guide p. 19: the 5.75% flat method is only for supplementals paid
  // SEPARATELY from regular wages. Paid with the regular check they are added
  // to wages and the formula is run once. John's taxable wages already sit in
  // the 5.75% band, so that aggregation happens to equal $57.50 — which is
  // why this is not `notEqual(delta, 57.50)`.
  assert.equal(vaSupplementalFlat("2026-03-15", "1000.00"), money("57.50"));
  const aggregated = VA_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 24, wages: "2649.00", supplemental: "1000.00",
    basis: "resident", certificate: cert({ personal_exemptions: "5" }),
  });
  const together = VA_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 24, wages: "3649.00",
    basis: "resident", certificate: cert({ personal_exemptions: "5" }),
  });
  assert.equal(aggregated.tax, together.tax);
  assert.equal(aggregated.taxSupplemental, money("0"));
});

test("VA refuses a year it has not transcribed", () => {
  assert.throws(
    () => VA_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 24, wages: "2649",
      basis: "resident", certificate: cert(),
    }),
    /2027 Virginia income tax withholding tables are not loaded.*Never extrapolate the prior year/s,
  );
});
