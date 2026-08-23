/**
 * Vermont withholding CONFORMANCE goldens.
 *
 * Every expected figure is transcribed from GB-1210 (2026) or is that
 * publication's own arithmetic on its own printed numbers.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  certificateDeclarationProblem, resolveCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
import "../../packs.ts";
import { D, mulRateCents, U } from "../../canada/decimal.ts";
import { VT_CERTIFICATE, VT_REGION, VT_WITHHOLDING, vtPeriodTax } from "./vt.ts";
import { pctToRate } from "./transcription.ts";
import { money, resolvedCertificate } from "./conformance-support.ts";

const cert = (answers: Record<string, string> = {}): ResolvedCertificate =>
  resolvedCertificate(VT_CERTIFICATE, answers);

test("VT certificate and region declarations are well formed", () => {
  assert.equal(certificateDeclarationProblem(VT_CERTIFICATE), null);
  assert.equal(VT_REGION.implemented, true);
  assert.equal(VT_REGION.certificateKey, "us_vt_w4vt");
});

test("VT printed percents and the booklet's $1,366.30 remainder", () => {
  assert.equal(pctToRate("3.35"), "0.0335");
  assert.equal(pctToRate("6.60"), "0.0660");
  // Official example: $1,366.30 × 3.35% = $45.77.
  assert.equal(D(mulRateCents(U("1366.30"), pctToRate("3.35"))), money("45.77"));
  assert.equal(vtPeriodTax(U("1592.30"), "weekly", true), U("45.77"));
});

test("VT GB-1210 example — $1,800 weekly, married, 2 allowances: $45.77", () => {
  // 2 × $103.85 = $207.70. $1,800 − $207.70 = $1,592.30.
  // Weekly Married: $0 + 3.35% of ($1,592.30 − $226) = $45.77.
  const result = VT_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1800.00",
    basis: "resident", certificate: cert({ filing_status: "married", allowances: "2" }),
  });
  assert.equal(result.factors.VT_WAGES, money("1800"));
  assert.equal(result.factors.VT_ALLOWANCE, money("207.70"));
  assert.equal(result.factors.VT_TAXABLE, money("1592.30"));
  assert.equal(result.tax, money("45.77"));
});

test("VT missing W-4VT withholds as single with zero allowances", () => {
  const empty = VT_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1800.00",
    basis: "resident", certificate: resolveCertificate({ certificate: VT_CERTIFICATE }),
  });
  const singleZero = VT_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1800.00",
    basis: "resident", certificate: cert({ filing_status: "single", allowances: "0" }),
  });
  assert.equal(empty.tax, singleZero.tax);
  assert.equal(empty.factors.VT_ALLOWANCE, money("0"));
});

test("VT extra withholding is added, exempt is zero, and an unpublished period is refused", () => {
  assert.equal(VT_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1800.00",
    basis: "resident",
    certificate: cert({ filing_status: "married", allowances: "2", additional_per_period: "5.00" }),
  }).tax, money("50.77"));
  assert.equal(VT_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "1800.00",
    basis: "resident", certificate: cert({ exempt: "true" }),
  }).tax, money("0"));
  assert.throws(
    () => VT_WITHHOLDING.compute({
      payDate: "2026-03-15", periodsPerYear: 13, wages: "1800",
      basis: "resident", certificate: cert({ filing_status: "married", allowances: "2" }),
    }),
    /publishes withholding tables/,
  );
});

test("VT refuses a year it has not transcribed", () => {
  assert.throws(
    () => VT_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 52, wages: "1800",
      basis: "resident", certificate: cert({ filing_status: "married", allowances: "2" }),
    }),
    /2027 Vermont income tax withholding tables are not loaded.*Never extrapolate the prior year/s,
  );
});
