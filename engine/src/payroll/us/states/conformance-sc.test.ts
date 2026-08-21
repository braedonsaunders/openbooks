/**
 * South Carolina withholding CONFORMANCE goldens.
 *
 * Every expected figure is transcribed from WH-1603F (2026) or is that
 * publication's own arithmetic on its own printed numbers.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  certificateDeclarationProblem, resolveCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
import "../../packs.ts";
import { D, mulRateCents, U } from "../../canada/decimal.ts";
import { SC_CERTIFICATE, SC_REGION } from "./sc-declaration.ts";
import {
  SC_RATES_2026, SC_WITHHOLDING, scAnnualTax, scStandardDeduction,
} from "./sc.ts";
import { pctToRate } from "./transcription.ts";

const money = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${(fraction + "0000").slice(0, 4)}`;
};

function cert(answers: Record<string, string> = {}): ResolvedCertificate {
  return resolveCertificate({
    certificate: SC_CERTIFICATE,
    stored: [{ certificateKey: SC_CERTIFICATE.key, answers, effectiveFrom: null }],
  });
}

test("SC certificate and region declarations are well formed", () => {
  assert.equal(certificateDeclarationProblem(SC_CERTIFICATE), null);
  assert.equal(SC_REGION.implemented, true);
  assert.equal(SC_REGION.certificateKey, "us_sc_scw4");
});

test("SC printed percents, addends and the $7,500 cap", () => {
  assert.equal(pctToRate("6"), "0.06");
  assert.equal(pctToRate("10"), "0.10");
  assert.equal(D(U("437.70") + mulRateCents(U("1870"), pctToRate("6"))), money("549.90"));
  assert.equal(scAnnualTax(U("20100"), SC_RATES_2026), U("549.90"));
  assert.equal(scAnnualTax(U("3639.99"), SC_RATES_2026), U("0"));
  assert.equal(scStandardDeduction(U("39000"), 3, SC_RATES_2026), U("3900"));
  assert.equal(scStandardDeduction(U("100000"), 1, SC_RATES_2026), U("7500"));
  assert.equal(scStandardDeduction(U("39000"), 0, SC_RATES_2026), U("0"));
});

test("SC WH-1603F example — $750 weekly, 3 allowances: $10.58", () => {
  // Annualize $750 × 52 = $39,000.
  // Personal allowance 3 × $5,000 = $15,000.
  // Standard deduction $39,000 × 10% = $3,900.
  // Taxable $20,100. ($20,100 − $18,230) × 6% + $437.70 = $549.90.
  // $549.90 ÷ 52 = $10.58.
  const result = SC_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "750.00",
    basis: "resident", certificate: cert({ allowances: "3" }),
  });
  assert.equal(result.factors.SC_ANNUAL_WAGES, money("39000"));
  assert.equal(result.factors.SC_PERSONAL_ALLOWANCE, money("15000"));
  assert.equal(result.factors.SC_STANDARD_DEDUCTION, money("3900"));
  assert.equal(result.factors.SC_TAXABLE, money("20100"));
  assert.equal(result.factors.SC_ANNUAL_TAX, money("549.90"));
  assert.equal(result.tax, money("10.58"));
});

test("SC no SC W-4 withholds at zero allowances", () => {
  const empty = SC_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "750.00",
    basis: "resident", certificate: resolveCertificate({ certificate: SC_CERTIFICATE }),
  });
  const zero = SC_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "750.00",
    basis: "resident", certificate: cert({ allowances: "0" }),
  });
  assert.equal(empty.tax, zero.tax);
  assert.equal(empty.factors.SC_STANDARD_DEDUCTION, money("0"));
  assert.equal(empty.factors.SC_PERSONAL_ALLOWANCE, money("0"));
});

test("SC extra withholding is added and exempt is zero", () => {
  const extra = SC_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "750.00",
    basis: "resident", certificate: cert({ allowances: "3", additional_per_period: "5.00" }),
  });
  assert.equal(extra.tax, money("15.58"));
  assert.equal(SC_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "750.00",
    basis: "resident", certificate: cert({ exempt: "true" }),
  }).tax, money("0"));
});

test("SC refuses a year it has not transcribed", () => {
  assert.throws(
    () => SC_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 52, wages: "750",
      basis: "resident", certificate: cert({ allowances: "3" }),
    }),
    /2027 South Carolina income tax withholding tables are not loaded.*Never extrapolate the prior year/s,
  );
});
