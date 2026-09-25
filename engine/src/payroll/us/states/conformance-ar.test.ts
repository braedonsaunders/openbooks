/**
 * Arkansas withholding CONFORMANCE goldens.
 *
 * Every expected figure is transcribed from the 2026 Formula Method PDF or is
 * that publication's own arithmetic on its own printed numbers.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  certificateDeclarationProblem, resolveCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
import "../../packs.ts";
import { D, mulRateCents, U } from "../../canada/decimal.ts";
import {
  AR_CERTIFICATE, AR_REGION, AR_RATES_2026, AR_WITHHOLDING, arAnnualGrossTax, arMidrangeLookup,
  arRoundToDollar,
} from "./ar.ts";
import { pctToRate } from "./transcription.ts";
import { money, resolvedCertificate } from "./conformance-support.ts";

const cert = (answers: Record<string, string> = {}): ResolvedCertificate =>
  resolvedCertificate(AR_CERTIFICATE, answers);

test("AR certificate and region declarations are well formed", () => {
  assert.equal(certificateDeclarationProblem(AR_CERTIFICATE), null);
  assert.equal(AR_REGION.implemented, true);
  assert.equal(AR_REGION.certificateKey, "us_ar_ar4ec");
});

test("AR printed percents, midrange lookup, and dollar rounding", () => {
  assert.equal(pctToRate("3.4"), "0.034");
  assert.equal(pctToRate("3.7"), "0.037");
  // Worked example: $23,054 → midrange of $23,000 and $23,100 = $23,050.
  assert.equal(arMidrangeLookup(U("23054"), AR_RATES_2026), U("23050"));
  assert.equal(arMidrangeLookup(U("23000"), AR_RATES_2026), U("23050"));
  assert.equal(arMidrangeLookup(U("97801"), AR_RATES_2026), U("97801"));
  // $23,050 × 3.4% − $287.97 = $495.73, rounded to $496.00.
  assert.equal(D(mulRateCents(U("23050"), pctToRate("3.4")) - U("287.97")), money("495.73"));
  assert.equal(arRoundToDollar(U("495.73")), U("496"));
  assert.equal(arAnnualGrossTax(U("97815.26"), AR_RATES_2026), U("3539"));
  assert.equal(arAnnualGrossTax(U("23054"), AR_RATES_2026), U("496"));
  assert.equal(arAnnualGrossTax(U("50000"), AR_RATES_2026), U("1485"));
  // Act 2 adjustment for $96,001–$96,100 is $160.00.
  assert.equal(arMidrangeLookup(U("96050"), AR_RATES_2026), U("96050"));
  assert.equal(arAnnualGrossTax(U("96050"), AR_RATES_2026), U("3314"));
});

test("AR formula example adds the AR4EC per-paycheck amount", () => {
  // Annualize $2,127 × 12 = $25,524.
  // Standard deduction $2,470 → net taxable $23,054 → midrange $23,050.
  // $23,050 × 3.4% − $287.97 = $495.73, rounded to $496.00.
  // Personal credits 2 × $29 = $58. Annual net $438; $36.50 + $25 = $61.50.
  const result = AR_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 12, wages: "2127.00",
    basis: "resident", certificate: cert({ exemptions: "2", additional_per_period: "25.00" }),
  });
  assert.equal(result.factors.AR_ANNUAL_WAGES, money("25524"));
  assert.equal(result.factors.AR_NET_TAXABLE, money("23054"));
  assert.equal(result.factors.AR_MIDRANGE, money("23050"));
  assert.equal(result.factors.AR_ADDITIONAL_WITHHOLDING, money("25"));
  assert.equal(result.factors.AR_PERSONAL_CREDITS, money("58"));
  assert.equal(result.factors.AR_ANNUAL_NET_TAX, money("438"));
  assert.equal(result.tax, money("61.50"));
});

test("AR no AR4EC withholds at zero exemptions", () => {
  const empty = AR_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 12, wages: "2127.00",
    basis: "resident", certificate: resolveCertificate({ certificate: AR_CERTIFICATE }),
  });
  const zero = AR_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 12, wages: "2127.00",
    basis: "resident", certificate: cert({ exemptions: "0" }),
  });
  assert.equal(empty.tax, zero.tax);
  assert.equal(empty.factors.AR_PERSONAL_CREDITS, money("0"));
  assert.equal(empty.tax, money("41.33"));
  // NFC low-income credit: $16,000 single → gross $173 (13550 × 3.4% − 287.97)
  // minus $58.72 credit = $114.28 for the year.
  assert.equal(AR_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 1, wages: "16000",
    basis: "resident", certificate: cert({ low_income: "true", filing_status: "single" }),
  }).tax, money("114.28"));
});

test("AR exempt is zero and a year it has not transcribed is refused", () => {
  assert.equal(AR_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 12, wages: "2127.00",
    basis: "resident", certificate: cert({ exempt: "true" }),
  }).tax, money("0"));
  assert.throws(
    () => AR_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 12, wages: "2127",
      basis: "resident", certificate: cert({ exemptions: "2" }),
    }),
    /2027 Arkansas income tax withholding tables are not available in this pack version.*update the pack.*Never extrapolate the prior year/s,
  );
});
