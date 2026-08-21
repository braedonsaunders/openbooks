/**
 * Maine withholding CONFORMANCE goldens.
 *
 * Every expected figure is transcribed from the 2026 Withholding Tables
 * booklet (Revised December 2025) or is that publication's own arithmetic
 * on its own printed numbers.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  certificateDeclarationProblem, resolveCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
import "../../packs.ts";
import { U } from "../../canada/decimal.ts";
import { ME_CERTIFICATE, ME_REGION } from "./me-declaration.ts";
import {
  ME_RATES_2026, ME_WITHHOLDING, meAnnualTax, meRoundToDollar, meStandardDeduction,
} from "./me.ts";
import { pctToRate } from "./transcription.ts";

const money = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${(fraction + "0000").slice(0, 4)}`;
};

function cert(answers: Record<string, string> = {}): ResolvedCertificate {
  return resolveCertificate({
    certificate: ME_CERTIFICATE,
    stored: [{ certificateKey: ME_CERTIFICATE.key, answers, effectiveFrom: null }],
  });
}

test("ME certificate and region declarations are well formed", () => {
  assert.equal(certificateDeclarationProblem(ME_CERTIFICATE), null);
  assert.equal(ME_REGION.implemented, true);
  assert.equal(ME_REGION.certificateKey, "us_me_w4me");
});

test("ME printed percents, phase-out, and Examples 2–3 annual arithmetic", () => {
  assert.equal(pctToRate("5.80"), "0.0580");
  assert.equal(pctToRate("6.75"), "0.0675");
  assert.equal(pctToRate("7.15"), "0.0715");
  assert.equal(meStandardDeduction(U("52000"), false, ME_RATES_2026), U("12450"));
  assert.equal(meStandardDeduction(U("102250"), false, ME_RATES_2026), U("12450"));
  assert.equal(meStandardDeduction(U("177250"), false, ME_RATES_2026), U("0"));
  // Example 3: $27,750 × $120,550 / $150,000 = $22,302 (booklet).
  assert.equal(meStandardDeduction(U("234000"), true, ME_RATES_2026), U("22302"));
  // Example 2 annualized withholding prints $1,694. Example 3 prints $13,338.
  assert.equal(meRoundToDollar(meAnnualTax(U("28950"), false)), U("1694"));
  assert.equal(meRoundToDollar(meAnnualTax(U("201098"), true)), U("13338"));
});

test("ME Example 1 — $300 weekly, single, 2 allowances: $0", () => {
  const result = ME_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "300.00",
    basis: "resident", certificate: cert({ filing_status: "single", allowances: "2" }),
  });
  assert.equal(result.factors.ME_ANNUAL_WAGES, money("15600"));
  assert.equal(result.factors.ME_ALLOWANCES, money("10600"));
  assert.equal(result.factors.ME_STANDARD_DEDUCTION, money("12450"));
  assert.equal(result.factors.ME_TAXABLE, money("0"));
  assert.equal(result.tax, money("0"));
});

test("ME Example 2 — $1,000 weekly, single, 2 allowances: $33", () => {
  // $52,000 − $10,600 − $12,450 = $28,950.
  // $1,589 + $1,550 × 6.75% = $1,693.625 → $1,694.
  // $1,694 ÷ 52 = $32.58, rounded to $33.
  const result = ME_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1000.00",
    basis: "resident", certificate: cert({ filing_status: "single", allowances: "2" }),
  });
  assert.equal(result.factors.ME_ANNUAL_WAGES, money("52000"));
  assert.equal(result.factors.ME_TAXABLE, money("28950"));
  assert.equal(result.factors.ME_ANNUAL_TAX, money("1694"));
  assert.equal(result.tax, money("33"));
});

test("ME Example 3 — $4,500 weekly, married, 2 allowances: $257", () => {
  // Standard deduction phases to $22,302. Taxable $201,098.
  // Annualized withholding $13,338. $13,338 ÷ 52 = $256.50 → $257.
  const result = ME_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "4500.00",
    basis: "resident", certificate: cert({ filing_status: "married", allowances: "2" }),
  });
  assert.equal(result.factors.ME_ANNUAL_WAGES, money("234000"));
  assert.equal(result.factors.ME_STANDARD_DEDUCTION, money("22302"));
  assert.equal(result.factors.ME_TAXABLE, money("201098"));
  assert.equal(result.factors.ME_ANNUAL_TAX, money("13338"));
  assert.equal(result.tax, money("257"));
});

test("ME missing W-4ME withholds as single with zero allowances", () => {
  const empty = ME_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1000.00",
    basis: "resident", certificate: resolveCertificate({ certificate: ME_CERTIFICATE }),
  });
  const singleZero = ME_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1000.00",
    basis: "resident", certificate: cert({ filing_status: "single", allowances: "0" }),
  });
  assert.equal(empty.tax, singleZero.tax);
  assert.equal(empty.factors.ME_ALLOWANCES, money("0"));
});

test("ME extra withholding is added and exempt is zero", () => {
  const extra = ME_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1000.00",
    basis: "resident",
    certificate: cert({ filing_status: "single", allowances: "2", additional_per_period: "5.00" }),
  });
  assert.equal(extra.tax, money("38"));
  assert.equal(ME_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1000.00",
    basis: "resident", certificate: cert({ exempt: "true" }),
  }).tax, money("0"));
});

test("ME refuses a year it has not transcribed", () => {
  assert.throws(
    () => ME_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 52, wages: "1000",
      basis: "resident", certificate: cert({ filing_status: "single", allowances: "2" }),
    }),
    /2027 Maine income tax withholding tables are not loaded.*Never extrapolate the prior year/s,
  );
});
