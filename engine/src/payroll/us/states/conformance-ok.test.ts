/**
 * Oklahoma withholding CONFORMANCE goldens.
 *
 * Every expected figure is transcribed from Packet OW-2 (Revised 11-2025)
 * or is that publication's own arithmetic on its own printed numbers.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  certificateDeclarationProblem, resolveCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
import "../../packs.ts";
import { D, mulRateCents, U } from "../../canada/decimal.ts";
import { OK_CERTIFICATE, OK_REGION, OK_RATES_2026, OK_WITHHOLDING, okPeriodTax } from "./ok.ts";
import { pctToRate } from "./transcription.ts";
import { money, resolvedCertificate } from "./conformance-support.ts";

const cert = (answers: Record<string, string> = {}): ResolvedCertificate =>
  resolvedCertificate(OK_CERTIFICATE, answers);

test("OK certificate and region declarations are well formed", () => {
  assert.equal(certificateDeclarationProblem(OK_CERTIFICATE), null);
  assert.equal(OK_REGION.implemented, true);
  assert.equal(OK_REGION.certificateKey, "us_ok_okw4");
});

test("OK printed percents and the sample's $612.66 remainder", () => {
  assert.equal(pctToRate("4.50"), "0.0450");
  assert.equal(D(mulRateCents(U("612.66"), pctToRate("4.50"))), money("27.57"));
  assert.equal(okPeriodTax(U("1741.66"), "semimonthly", true, OK_RATES_2026), U("36.67"));
});

test("OK Packet OW-2 sample — $1,825 semi-monthly, married, 2 allowances: $37", () => {
  // $41.67 × 2 = $83.34. $1,825.00 − $83.34 = $1,741.66.
  // Table 3 Married: $9.10 + 4.5% of ($1,741.66 − $1,129.00) = $36.67 → $37.00.
  const result = OK_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 24, wages: "1825.00",
    basis: "resident",
    certificate: cert({ filing_status: "married", allowances: "2" }),
  });
  assert.equal(result.factors.OK_ALLOWANCE, money("83.34"));
  assert.equal(result.factors.OK_TAXABLE, money("1741.66"));
  assert.equal(result.factors.OK_UNROUNDED, money("36.67"));
  assert.equal(result.tax, money("37"));
});

test("OK blank OK-W-4 withholds as single with zero allowances", () => {
  const empty = OK_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 24, wages: "1825.00",
    basis: "resident", certificate: resolveCertificate({ certificate: OK_CERTIFICATE }),
  });
  const singleZero = OK_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 24, wages: "1825.00",
    basis: "resident", certificate: cert({ filing_status: "single", allowances: "0" }),
  });
  assert.equal(empty.tax, singleZero.tax);
  assert.equal(empty.factors.OK_ALLOWANCE, money("0"));
});

test("OK extra withholding is added, exempt is zero, and an unpublished period is refused", () => {
  assert.equal(OK_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 24, wages: "1825.00",
    basis: "resident",
    certificate: cert({ filing_status: "married", allowances: "2", additional_per_period: "5.00" }),
  }).tax, money("42"));
  assert.equal(OK_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 24, wages: "1825.00",
    basis: "resident", certificate: cert({ exempt: "true" }),
  }).tax, money("0"));
  assert.throws(
    () => OK_WITHHOLDING.compute({
      payDate: "2026-03-15", periodsPerYear: 13, wages: "1825",
      basis: "resident", certificate: cert({ filing_status: "married", allowances: "2" }),
    }),
    /publishes withholding tables/,
  );
});

test("OK refuses a year it has not transcribed", () => {
  assert.throws(
    () => OK_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 24, wages: "1825",
      basis: "resident", certificate: cert({ filing_status: "married", allowances: "2" }),
    }),
    /2027 Oklahoma income tax withholding tables are not loaded.*Never extrapolate the prior year/s,
  );
});
