/**
 * Hawaii withholding CONFORMANCE goldens.
 *
 * Every expected figure is transcribed from Booklet A (Rev. 2025) or is that
 * publication's own arithmetic on its own printed numbers.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  certificateDeclarationProblem, resolveCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
import "../../packs.ts";
import { D, mulRateCents, U } from "../../canada/decimal.ts";
import { HI_CERTIFICATE, HI_REGION, HI_RATES_2026, HI_WITHHOLDING, hiAnnualTax } from "./hi.ts";
import { pctToRate } from "./transcription.ts";

const money = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${(fraction + "0000").slice(0, 4)}`;
};

function cert(answers: Record<string, string> = {}): ResolvedCertificate {
  return resolveCertificate({
    certificate: HI_CERTIFICATE,
    stored: [{ certificateKey: HI_CERTIFICATE.key, answers, effectiveFrom: null }],
  });
}

test("HI certificate and region declarations are well formed", () => {
  assert.equal(certificateDeclarationProblem(HI_CERTIFICATE), null);
  assert.equal(HI_REGION.implemented, true);
  assert.equal(HI_REGION.certificateKey, "us_hi_hw4");
});

test("HI printed percents and the booklet's $3,818 remainder", () => {
  assert.equal(pctToRate("5.50"), "0.0550");
  assert.equal(D(mulRateCents(U("3818"), pctToRate("5.50"))), money("209.99"));
  assert.equal(hiAnnualTax(U("18218"), false, HI_RATES_2026), U("497.99"));
});

test("HI Booklet A example — $500 weekly, single, 3 allowances: $9.58", () => {
  // $500 × 52 = $26,000. Allowances 3 × $1,144 = $3,432. Lump-sum $4,350.
  // Taxable $18,218. $288 + $3,818 × 5.5% = $497.99. $497.99 ÷ 52 = $9.58.
  const result = HI_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00",
    basis: "resident", certificate: cert({ filing_status: "single", allowances: "3" }),
  });
  assert.equal(result.factors.HI_ANNUAL_WAGES, money("26000"));
  assert.equal(result.factors.HI_ALLOWANCES, money("3432"));
  assert.equal(result.factors.HI_LUMP_SUM, money("4350"));
  assert.equal(result.factors.HI_TAXABLE, money("18218"));
  assert.equal(result.factors.HI_ANNUAL_TAX, money("497.99"));
  assert.equal(result.tax, money("9.58"));
});

test("HI no HW-4 withholds as single with zero allowances", () => {
  const empty = HI_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00",
    basis: "resident", certificate: resolveCertificate({ certificate: HI_CERTIFICATE }),
  });
  const singleZero = HI_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00",
    basis: "resident", certificate: cert({ filing_status: "single", allowances: "0" }),
  });
  assert.equal(empty.tax, singleZero.tax);
  assert.equal(empty.factors.HI_ALLOWANCES, money("0"));
});

test("HI extra withholding is added and exempt is zero", () => {
  assert.equal(HI_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00",
    basis: "resident",
    certificate: cert({ filing_status: "single", allowances: "3", additional_per_period: "5.00" }),
  }).tax, money("14.58"));
  assert.equal(HI_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00",
    basis: "resident", certificate: cert({ exempt: "true" }),
  }).tax, money("0"));
});

test("HI refuses a year it has not transcribed", () => {
  assert.throws(
    () => HI_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 52, wages: "500",
      basis: "resident", certificate: cert({ filing_status: "single", allowances: "3" }),
    }),
    /2027 Hawaii income tax withholding tables are not loaded.*Never extrapolate the prior year/s,
  );
});
