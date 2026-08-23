/**
 * Missouri withholding CONFORMANCE goldens.
 *
 * Every expected figure is transcribed from the 2026 Withholding Tax Formula
 * or is that publication's own arithmetic on its own printed numbers.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  certificateDeclarationProblem, resolveCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
import "../../packs.ts";
import { D, mulRateCents, U } from "../../canada/decimal.ts";
import { MO_CERTIFICATE, MO_REGION, MO_RATES_2026, MO_WITHHOLDING, moAnnualTax } from "./mo.ts";
import { pctToRate } from "./transcription.ts";

const money = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${(fraction + "0000").slice(0, 4)}`;
};

function cert(answers: Record<string, string> = {}): ResolvedCertificate {
  return resolveCertificate({
    certificate: MO_CERTIFICATE,
    stored: [{ certificateKey: MO_CERTIFICATE.key, answers, effectiveFrom: null }],
  });
}

test("MO certificate and region declarations are well formed", () => {
  assert.equal(certificateDeclarationProblem(MO_CERTIFICATE), null);
  assert.equal(MO_REGION.implemented, true);
  assert.equal(MO_REGION.certificateKey, "us_mo_mow4");
});

test("MO printed percents and the formula's $9,464 excess", () => {
  assert.equal(pctToRate("4.70"), "0.0470");
  assert.equal(D(mulRateCents(U("9464"), pctToRate("4.70"))), money("444.81"));
  assert.equal(moAnnualTax(U("18900"), MO_RATES_2026), U("707.81"));
});

test("MO formula example — $35,000 annual, married spouse works: $59 monthly", () => {
  // $2,916.67 × 12 = $35,000.04. Standard deduction $16,100. Taxable $18,900.04.
  // $263 + $9,464.04 × 4.7% = $707.81. $707.81 ÷ 12 = $59.00.
  const result = MO_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 12, wages: "2916.67",
    basis: "resident",
    certificate: cert({ filing_status: "married_spouse_works" }),
  });
  assert.equal(result.factors.MO_STANDARD_DEDUCTION, money("16100"));
  assert.equal(result.factors.MO_ANNUAL_TAX, money("707.81"));
  assert.equal(result.tax, money("59"));
});

test("MO no MO W-4 withholds at the single rate", () => {
  const empty = MO_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 12, wages: "2916.67",
    basis: "resident", certificate: resolveCertificate({ certificate: MO_CERTIFICATE }),
  });
  const single = MO_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 12, wages: "2916.67",
    basis: "resident", certificate: cert({ filing_status: "single" }),
  });
  assert.equal(empty.tax, single.tax);
  assert.equal(empty.factors.MO_STANDARD_DEDUCTION, money("16100"));
});

test("MO extra withholding is added, exempt is zero, and an unpublished period is refused", () => {
  assert.equal(MO_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 12, wages: "2916.67",
    basis: "resident",
    certificate: cert({ filing_status: "married_spouse_works", additional_per_period: "10.00" }),
  }).tax, money("69"));
  assert.equal(MO_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 12, wages: "2916.67",
    basis: "resident", certificate: cert({ exempt: "true" }),
  }).tax, money("0"));
  assert.throws(
    () => MO_WITHHOLDING.compute({
      payDate: "2026-03-15", periodsPerYear: 13, wages: "2916.67",
      basis: "resident", certificate: cert({ filing_status: "single" }),
    }),
    /publishes withholding tables/,
  );
});

test("MO refuses a year it has not transcribed", () => {
  assert.throws(
    () => MO_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 12, wages: "2916.67",
      basis: "resident", certificate: cert({ filing_status: "married_spouse_works" }),
    }),
    /2027 Missouri income tax withholding tables are not loaded.*Never extrapolate the prior year/s,
  );
});
