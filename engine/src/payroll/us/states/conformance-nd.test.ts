/**
 * North Dakota withholding CONFORMANCE goldens.
 *
 * Every expected figure is transcribed from the 2026 Rates and Instructions
 * booklet or is that publication's own arithmetic on its own printed numbers.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  certificateDeclarationProblem, resolveCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
import "../../packs.ts";
import { D, mulRateCents, U } from "../../canada/decimal.ts";
import { ND_CERTIFICATE, ND_REGION } from "./nd-declaration.ts";
import { ND_RATES_2026, ND_WITHHOLDING, ndAnnualTax } from "./nd.ts";
import { pctToRate } from "./transcription.ts";

const money = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${(fraction + "0000").slice(0, 4)}`;
};

function cert(answers: Record<string, string> = {}): ResolvedCertificate {
  return resolveCertificate({
    certificate: ND_CERTIFICATE,
    stored: [{ certificateKey: ND_CERTIFICATE.key, answers, effectiveFrom: null }],
  });
}

test("ND certificate and region declarations are well formed", () => {
  assert.equal(certificateDeclarationProblem(ND_CERTIFICATE), null);
  assert.equal(ND_REGION.implemented, true);
  assert.equal(ND_REGION.certificateKey, "us_nd_w4");
});

test("ND printed percents and the Single table's $35,975 remainder", () => {
  assert.equal(pctToRate("1.95"), "0.0195");
  assert.equal(pctToRate("2.50"), "0.0250");
  assert.equal(D(mulRateCents(U("35975"), pctToRate("1.95"))), money("701.51"));
  assert.equal(ndAnnualTax(U("93600"), "single", ND_RATES_2026), U("701.51"));
});

test("ND Section 2 worksheet — $1,800 weekly Single, table arithmetic", () => {
  // Booklet lines 1–3: $1,800 × 52 = $93,600.
  // Single table: $0 + 1.95% of ($93,600 − $57,625) = $701.51.
  // $701.51 ÷ 52 = $13.49, nearest dollar $13.
  // The booklet prints line 4 as $734.00 / line 5 as $14.00 — those figures
  // match the wage-bracket cell for $1,800–$1,825 weekly Single, not this
  // table. The engine follows the Annual Percentage Method Table.
  const result = ND_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1800.00",
    basis: "resident", certificate: cert({ filing_status: "single" }),
  });
  assert.equal(result.factors.ND_ANNUAL_WAGES, money("93600"));
  assert.equal(result.factors.ND_ANNUAL_TAX, money("701.51"));
  assert.equal(result.tax, money("13"));
});

test("ND no W-4 withholds as single", () => {
  const empty = ND_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1800.00",
    basis: "resident", certificate: resolveCertificate({ certificate: ND_CERTIFICATE }),
  });
  const single = ND_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1800.00",
    basis: "resident", certificate: cert({ filing_status: "single" }),
  });
  assert.equal(empty.tax, single.tax);
});

test("ND extra withholding is added, exempt is zero, and an unpublished period is refused", () => {
  assert.equal(ND_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1800.00",
    basis: "resident",
    certificate: cert({ filing_status: "single", additional_per_period: "5.00" }),
  }).tax, money("18"));
  assert.equal(ND_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1800.00",
    basis: "resident", certificate: cert({ exempt: "true" }),
  }).tax, money("0"));
  assert.throws(
    () => ND_WITHHOLDING.compute({
      payDate: "2026-03-15", periodsPerYear: 1, wages: "93600",
      basis: "resident", certificate: cert({ filing_status: "single" }),
    }),
    /publishes withholding tables/,
  );
});

test("ND refuses a year it has not transcribed", () => {
  assert.throws(
    () => ND_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 52, wages: "1800",
      basis: "resident", certificate: cert({ filing_status: "single" }),
    }),
    /2027 North Dakota income tax withholding tables are not loaded.*Never extrapolate the prior year/s,
  );
});
