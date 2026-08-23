/**
 * Kansas withholding CONFORMANCE goldens.
 *
 * Every expected figure is transcribed from KW-100's own Esmeralda Espinoza
 * walkthrough or is that publication's own arithmetic on its own printed
 * numbers.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  certificateDeclarationProblem, resolveCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
import "../../packs.ts";
import { D, mulRateCents, U } from "../../canada/decimal.ts";
import {
  KS_CERTIFICATE, KS_REGION, KS_TABLES, KS_WITHHOLDING, ksAllowance, ksPeriodTax,
} from "./ks.ts";
import { pctToRate } from "./transcription.ts";
import { money, resolvedCertificate } from "./conformance-support.ts";

const cert = (answers: Record<string, string> = {}): ResolvedCertificate =>
  resolvedCertificate(KS_CERTIFICATE, answers);

test("KS certificate and region declarations are well formed", () => {
  assert.equal(certificateDeclarationProblem(KS_CERTIFICATE), null);
  assert.equal(KS_REGION.implemented, true);
  assert.equal(KS_REGION.certificateKey, "us_ks_k4");
});

test("KS printed percents and Esmeralda's $797 remainder", () => {
  assert.equal(pctToRate("5.2"), "0.052");
  assert.equal(pctToRate("5.58"), "0.0558");
  // $763.33 + (1 × $96.67) = $860. $2,000 − $860 = $1,140. $1,140 − $343 = $797.
  assert.equal(ksAllowance("semimonthly", true, 3), U("860"));
  assert.equal(D(mulRateCents(U("797"), pctToRate("5.2"))), money("41.44"));
  assert.equal(ksPeriodTax(U("1140"), "semimonthly", true), U("41.44"));
  assert.equal(KS_TABLES.semimonthly.marriedJoint, "763.33");
  assert.equal(KS_TABLES.semimonthly.dependent, "96.67");
});

test("KS KW-100 example — Esmeralda $2,000 semi-monthly, married, 3 allowances: $41.44", () => {
  // $18,320 + $2,320 = $20,640. $20,640 ÷ 24 = $860.
  // $2,000 − $860 = $1,140. 5.2% of the amount over $343. $797 × 5.2% = $41.44.
  const result = KS_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 24, wages: "2000.00",
    basis: "resident",
    certificate: cert({ filing_status: "married", allowances: "3" }),
  });
  assert.equal(result.factors.KS_WAGES, money("2000"));
  assert.equal(result.factors.KS_ALLOWANCE, money("860"));
  assert.equal(result.factors.KS_TAXABLE, money("1140"));
  assert.equal(result.tax, money("41.44"));
});

test("KS no K-4 withholds as single with zero allowances", () => {
  const empty = KS_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 24, wages: "2000.00",
    basis: "resident", certificate: resolveCertificate({ certificate: KS_CERTIFICATE }),
  });
  const singleZero = KS_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 24, wages: "2000.00",
    basis: "resident", certificate: cert({ filing_status: "single", allowances: "0" }),
  });
  assert.equal(empty.tax, singleZero.tax);
  assert.equal(empty.factors.KS_ALLOWANCE, money("0"));
});

test("KS extra withholding is added and exempt is zero", () => {
  assert.equal(KS_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 24, wages: "2000.00",
    basis: "resident",
    certificate: cert({
      filing_status: "married", allowances: "3", additional_per_period: "10.00",
    }),
  }).tax, money("51.44"));
  assert.equal(KS_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 24, wages: "2000.00",
    basis: "resident", certificate: cert({ exempt: "true" }),
  }).tax, money("0"));
});

test("KS refuses a year it has not transcribed", () => {
  assert.throws(
    () => KS_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 24, wages: "2000",
      basis: "resident", certificate: cert({ filing_status: "married", allowances: "3" }),
    }),
    /2027 Kansas income tax withholding tables are not loaded.*Never extrapolate the prior year/s,
  );
});
