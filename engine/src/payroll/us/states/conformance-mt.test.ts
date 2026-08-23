/**
 * Montana withholding CONFORMANCE goldens.
 *
 * Every expected figure is transcribed from the 2026 Employer and Information
 * Agent Guide or is that publication's own arithmetic on its own printed numbers.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  certificateDeclarationProblem, resolveCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
import "../../packs.ts";
import { D, mulRateCents, U } from "../../canada/decimal.ts";
import { MT_CERTIFICATE, MT_REGION, MT_RATES_2026, MT_WITHHOLDING, mtPeriodTax } from "./mt.ts";
import { pctToRate } from "./transcription.ts";
import { money, resolvedCertificate } from "./conformance-support.ts";

const cert = (answers: Record<string, string> = {}): ResolvedCertificate =>
  resolvedCertificate(MT_CERTIFICATE, answers);

test("MT certificate and region declarations are well formed", () => {
  assert.equal(certificateDeclarationProblem(MT_CERTIFICATE), null);
  assert.equal(MT_REGION.implemented, true);
  assert.equal(MT_REGION.certificateKey, "us_mt_mw4");
});

test("MT printed percents and the guide's $704 remainder", () => {
  assert.equal(pctToRate("4.70"), "0.0470");
  assert.equal(pctToRate("5.65"), "0.0565");
  assert.equal(D(mulRateCents(U("704"), pctToRate("4.7"))), money("33.09"));
  assert.equal(mtPeriodTax(U("1375"), "semimonthly", "single_or_both", MT_RATES_2026), U("33.09"));
});

test("MT Example 1a — $1,375 semi-monthly, line 1a: $33", () => {
  // $0 + (0.047 × ($1,375 − $671)) = $33.09, nearest dollar $33.
  const result = MT_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 24, wages: "1375.00",
    basis: "resident", certificate: cert({ filing_status: "single_or_both" }),
  });
  assert.equal(result.factors.MT_UNROUNDED, money("33.09"));
  assert.equal(result.tax, money("33"));
});

test("MT Example line 2 — $2,950 bi-weekly: $114", () => {
  // $86 + (0.0565 × ($2,950 − $2,446)) = $114.48, nearest dollar $114.
  const result = MT_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 26, wages: "2950.00",
    basis: "resident", certificate: cert({ filing_status: "single_or_both" }),
  });
  assert.equal(result.tax, money("114"));
});

test("MT Example 1a weekly — $475: $8", () => {
  // $0 + (0.047 × ($475 − $310)) = $7.76, nearest dollar $8.
  assert.equal(MT_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "475.00",
    basis: "resident", certificate: cert({ filing_status: "single_or_both" }),
  }).tax, money("8"));
});

test("MT Example 1b — $1,375 semi-monthly: $2", () => {
  // $0 + (0.047 × ($1,375 − $1,342)) = $1.55, nearest dollar $2.
  assert.equal(MT_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 24, wages: "1375.00",
    basis: "resident", certificate: cert({ filing_status: "married_joint" }),
  }).tax, money("2"));
});

test("MT Example 1c — $1,375 semi-monthly: $17", () => {
  // $0 + (0.047 × ($1,375 − $1,006)) = $17.34, nearest dollar $17.
  assert.equal(MT_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 24, wages: "1375.00",
    basis: "resident", certificate: cert({ filing_status: "head_household" }),
  }).tax, money("17"));
});

test("MT no MW-4 withholds as line 1a single", () => {
  const empty = MT_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 24, wages: "1375.00",
    basis: "resident", certificate: resolveCertificate({ certificate: MT_CERTIFICATE }),
  });
  const line1a = MT_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 24, wages: "1375.00",
    basis: "resident", certificate: cert({ filing_status: "single_or_both" }),
  });
  assert.equal(empty.tax, line1a.tax);
  assert.equal(empty.tax, money("33"));
});

test("MT extra withholding is added, exempt is zero, and an unpublished period is refused", () => {
  assert.equal(MT_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 24, wages: "1375.00",
    basis: "resident",
    certificate: cert({ filing_status: "single_or_both", additional_per_period: "5.00" }),
  }).tax, money("38"));
  assert.equal(MT_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 24, wages: "1375.00",
    basis: "resident", certificate: cert({ exempt: "true" }),
  }).tax, money("0"));
  assert.throws(
    () => MT_WITHHOLDING.compute({
      payDate: "2026-03-15", periodsPerYear: 13, wages: "1375",
      basis: "resident", certificate: cert({ filing_status: "single_or_both" }),
    }),
    /publishes withholding tables/,
  );
});

test("MT refuses a year it has not transcribed", () => {
  assert.throws(
    () => MT_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 24, wages: "1375",
      basis: "resident", certificate: cert({ filing_status: "single_or_both" }),
    }),
    /2027 Montana income tax withholding tables are not loaded.*Never extrapolate the prior year/s,
  );
});
