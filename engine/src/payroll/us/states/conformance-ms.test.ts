/**
 * Mississippi withholding CONFORMANCE goldens.
 *
 * Every expected figure is transcribed from Pub. 89-700-25-1 (Rev. 07/25),
 * the Computer Payroll Accounting flowchart (Rev. 8/13/25), or Weekly 2026
 * Table A / Table C — official printed wage → withheld cells.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  certificateDeclarationProblem, resolveCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
import "../../packs.ts";
import { D, mulRateCents, U } from "../../canada/decimal.ts";
import {
  MS_CERTIFICATE, MS_REGION, MS_RATES_2026, MS_WITHHOLDING, msAnnualTax, msRoundToDollar,
} from "./ms.ts";
import { pctToRate } from "./transcription.ts";
import { money, resolvedCertificate } from "./conformance-support.ts";

const cert = (answers: Record<string, string> = {}): ResolvedCertificate =>
  resolvedCertificate(MS_CERTIFICATE, answers);

test("MS certificate and region declarations are well formed", () => {
  assert.equal(certificateDeclarationProblem(MS_CERTIFICATE), null);
  assert.equal(MS_REGION.implemented, true);
  assert.equal(MS_REGION.certificateKey, "us_ms_89350");
});

test("MS printed 4.0% and the flowchart's $13,700 remainder", () => {
  assert.equal(pctToRate("4.0"), "0.040");
  // Weekly $500 × 52 = $26,000. Single standard deduction $2,300. Taxable $23,700.
  // Excess over $10,000 is $13,700. $13,700 × 4.0% = $548.
  assert.equal(D(mulRateCents(U("13700"), pctToRate("4.0"))), money("548"));
  assert.equal(msAnnualTax(U("23700"), MS_RATES_2026), U("548"));
  assert.equal(msRoundToDollar(U("10.54")), U("11"));
});

test("MS Weekly 2026 Table A — $500 weekly, Single, $0 exemption: $11", () => {
  // Official cell: wages at least $500 but less than $510, exemption $0 → $11.
  // Flowchart: $500 × 52 = $26,000 − $2,300 = $23,700. 4% of $13,700 = $548.
  // $548 ÷ 52 = $10.54, nearest dollar $11.
  const result = MS_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00",
    basis: "resident",
    certificate: cert({ filing_status: "single", exemption: "0" }),
  });
  assert.equal(result.factors.MS_ANNUAL_WAGES, money("26000"));
  assert.equal(result.factors.MS_STANDARD_DEDUCTION, money("2300"));
  assert.equal(result.factors.MS_EXEMPTION, money("0"));
  assert.equal(result.factors.MS_TAXABLE, money("23700"));
  assert.equal(result.factors.MS_ANNUAL_TAX, money("548"));
  assert.equal(result.tax, money("11"));
});

test("MS Weekly 2026 Table A — $500 weekly, Single, $6,000 exemption: $6", () => {
  // Official cell: wages $500–$510, exemption $6,000 → $6.
  // $26,000 − $6,000 − $2,300 = $17,700. 4% of $7,700 = $308. $308 ÷ 52 = $5.92 → $6.
  const result = MS_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00",
    basis: "resident",
    certificate: cert({ filing_status: "single", exemption: "6000" }),
  });
  assert.equal(result.factors.MS_TAXABLE, money("17700"));
  assert.equal(result.factors.MS_ANNUAL_TAX, money("308"));
  assert.equal(result.tax, money("6"));
});

test("MS Weekly 2026 Table C — $500 weekly, married one-spouse, $0 exemption: $9", () => {
  // Official cell: wages $500–$510, exemption $0 → $9.
  // $26,000 − $4,600 = $21,400. 4% of $11,400 = $456. $456 ÷ 52 = $8.77 → $9.
  const result = MS_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00",
    basis: "resident",
    certificate: cert({ filing_status: "married_one", exemption: "0" }),
  });
  assert.equal(result.factors.MS_STANDARD_DEDUCTION, money("4600"));
  assert.equal(result.factors.MS_TAXABLE, money("21400"));
  assert.equal(result.factors.MS_ANNUAL_TAX, money("456"));
  assert.equal(result.tax, money("9"));
});

test("MS no 89-350 withholds as Single with zero exemption", () => {
  const empty = MS_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00",
    basis: "resident", certificate: resolveCertificate({ certificate: MS_CERTIFICATE }),
  });
  const singleZero = MS_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00",
    basis: "resident",
    certificate: cert({ filing_status: "single", exemption: "0" }),
  });
  assert.equal(empty.tax, singleZero.tax);
  assert.equal(empty.factors.MS_EXEMPTION, money("0"));
  assert.equal(empty.factors.MS_STANDARD_DEDUCTION, money("2300"));
});

test("MS extra withholding is added, exempt is zero, and an unpublished period is refused", () => {
  assert.equal(MS_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00",
    basis: "resident",
    certificate: cert({ filing_status: "single", exemption: "0", additional_per_period: "5.00" }),
  }).tax, money("16"));
  assert.equal(MS_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00",
    basis: "resident", certificate: cert({ exempt: "true" }),
  }).tax, money("0"));
  assert.throws(
    () => MS_WITHHOLDING.compute({
      payDate: "2026-03-15", periodsPerYear: 13, wages: "500",
      basis: "resident", certificate: cert({ filing_status: "single" }),
    }),
    /publishes withholding tables/,
  );
});

test("MS refuses a year it has not transcribed", () => {
  assert.throws(
    () => MS_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 52, wages: "500",
      basis: "resident", certificate: cert({ filing_status: "single" }),
    }),
    /2027 Mississippi income tax withholding tables are not loaded.*Never extrapolate the prior year/s,
  );
});
