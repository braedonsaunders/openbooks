/**
 * Nebraska withholding CONFORMANCE goldens.
 *
 * Every expected figure is transcribed from Circular EN (2026) Table 7 or from
 * the official Weekly Wage Bracket Table cell for $500–$510 / Single / 0
 * allowances ($14.38). Circular EN constructs that cell from the mid-point of
 * the wage bracket ($505).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  certificateDeclarationProblem, resolveCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
import "../../packs.ts";
import { D, mulRateCents, U } from "../../canada/decimal.ts";
import { NE_CERTIFICATE, NE_REGION, NE_RATES_2026, NE_WITHHOLDING, neAnnualTax } from "./ne.ts";
import { pctToRate } from "./transcription.ts";

const money = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${(fraction + "0000").slice(0, 4)}`;
};

function cert(answers: Record<string, string> = {}): ResolvedCertificate {
  return resolveCertificate({
    certificate: NE_CERTIFICATE,
    stored: [{ certificateKey: NE_CERTIFICATE.key, answers, effectiveFrom: null }],
  });
}

test("NE certificate and region declarations are well formed", () => {
  assert.equal(certificateDeclarationProblem(NE_CERTIFICATE), null);
  assert.equal(NE_REGION.implemented, true);
  assert.equal(NE_REGION.certificateKey, "us_ne_w4n");
});

test("NE printed percents and Table 7's $4,450 remainder", () => {
  assert.equal(pctToRate("4.21"), "0.0421");
  // Mid-point of the printed $500–$510 weekly cell is $505. $505 × 52 = $26,260.
  // Table 7 Single: $560.35 + 4.21% of ($26,260 − $21,810) = $560.35 + $187.35.
  assert.equal(D(mulRateCents(U("4450"), pctToRate("4.21"))), money("187.35"));
  assert.equal(neAnnualTax(U("26260"), false, NE_RATES_2026), U("747.70"));
});

test("NE Weekly Wage Bracket — $500–$510 / Single / 0 allowances: $14.38", () => {
  // Official cell: wages at least $500 but less than $510, 0 allowances → $14.38.
  // Circular EN builds non-shaded cells from the mid-point ($505).
  // $505 × 52 = $26,260. Table 7: $747.70. $747.70 ÷ 52 = $14.38.
  const result = NE_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "505.00",
    basis: "resident",
    certificate: cert({ filing_status: "single", allowances: "0" }),
  });
  assert.equal(result.factors.NE_ANNUAL_WAGES, money("26260"));
  assert.equal(result.factors.NE_ALLOWANCES, money("0"));
  assert.equal(result.factors.NE_TAXABLE, money("26260"));
  assert.equal(result.factors.NE_ANNUAL_TAX, money("747.70"));
  assert.equal(result.tax, money("14.38"));
});

test("NE no W-4N withholds as single with zero allowances", () => {
  const empty = NE_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "505.00",
    basis: "resident", certificate: resolveCertificate({ certificate: NE_CERTIFICATE }),
  });
  const singleZero = NE_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "505.00",
    basis: "resident",
    certificate: cert({ filing_status: "single", allowances: "0" }),
  });
  assert.equal(empty.tax, singleZero.tax);
  assert.equal(empty.factors.NE_ALLOWANCES, money("0"));
});

test("NE extra withholding is added, exempt is zero, and an unpublished period is refused", () => {
  assert.equal(NE_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "505.00",
    basis: "resident",
    certificate: cert({ filing_status: "single", allowances: "0", additional_per_period: "5.00" }),
  }).tax, money("19.38"));
  assert.equal(NE_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "505.00",
    basis: "resident", certificate: cert({ exempt: "true" }),
  }).tax, money("0"));
  assert.throws(
    () => NE_WITHHOLDING.compute({
      payDate: "2026-03-15", periodsPerYear: 13, wages: "505",
      basis: "resident", certificate: cert({ filing_status: "single" }),
    }),
    /publishes withholding tables/,
  );
});

test("NE refuses a year it has not transcribed", () => {
  assert.throws(
    () => NE_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 52, wages: "505",
      basis: "resident", certificate: cert({ filing_status: "single" }),
    }),
    /2027 Nebraska income tax withholding tables are not loaded.*Never extrapolate the prior year/s,
  );
});
