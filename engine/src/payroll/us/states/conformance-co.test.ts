/**
 * Colorado DR 1098 goldens.
 *
 * Every expected figure is the worksheet's own arithmetic on the digits the
 * Department's current 2026 DR 1098 prints (4.40%, $11,000 / $5,500):
 * https://tax.colorado.gov/sites/tax/files/documents/DR_1098_Colorado_Withholding_Worksheet_for_Employees.pdf
 * The 2026 W-4-only exemption instruction is in the worksheet and Colorado
 * Wage Withholding Tax Guide (Jan. 2026):
 * https://tax.colorado.gov/sites/tax/files/documents/Wage_Withholding_Tax_Guide_Jan_2026.pdf
 * DR 1098 publishes no worked dollar example, so these are labelled substitutes — the same honesty
 * conformance-tranche2.test.ts uses for Ohio and Michigan.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ResolvedCertificate } from "../../certificates.ts";
import { CO_CERTIFICATE, CO_DR1059_CERTIFICATE, CO_RATES_2026, CO_WITHHOLDING } from "./co.ts";
import { money, resolvedCertificate } from "./conformance-support.ts";

const cert = (answers: Record<string, string> = {}): ResolvedCertificate =>
  resolvedCertificate(CO_CERTIFICATE, answers);

test("CO DR 1098 — 2026 weekly $1,000, W-4 single status, no DR 0004 allowance: $39.35", () => {
  // 1c $52,000 − 2a $5,500 = $46,500 × 4.40% = $2,046.00 ÷ 52 = $39.3461… → $39.35
  const result = CO_WITHHOLDING.compute({
    payDate: "2026-03-06",
    periodsPerYear: 52,
    wages: "1000.00",
    basis: "resident",
    certificate: cert(),
    federalFilingStatus: "single",
  });
  assert.equal(result.tax, money("39.35"));
  assert.equal(result.factors.CO_ANNUAL_ALLOWANCE, money("5500"));
  assert.equal(result.year, CO_RATES_2026.year);
});

test("CO DR 1098 — 2026 weekly $1,000, married filing jointly default: $34.69", () => {
  // 1c $52,000 − 2a $11,000 = $41,000 × 4.40% = $1,804.00 ÷ 52 = $34.6923… → $34.69
  const result = CO_WITHHOLDING.compute({
    payDate: "2026-03-06",
    periodsPerYear: 52,
    wages: "1000.00",
    basis: "resident",
    certificate: cert(),
    federalFilingStatus: "married_joint",
  });
  assert.equal(result.tax, money("34.69"));
  assert.equal(result.factors.CO_ANNUAL_ALLOWANCE, money("11000"));
});

test("CO DR 1098 — DR 0004 line 2 overrides the W-4 default", () => {
  const result = CO_WITHHOLDING.compute({
    payDate: "2026-03-06",
    periodsPerYear: 52,
    wages: "1000.00",
    basis: "resident",
    certificate: cert({ annual_allowance: "0" }),
    federalFilingStatus: "married_joint",
  });
  // $52,000 × 4.40% = $2,288.00 ÷ 52 = $44.00; line 2 overrides the default.
  assert.equal(result.tax, money("44.00"));
  assert.equal(result.factors.CO_ANNUAL_ALLOWANCE, money("0"));
});

test("CO DR 1098 — extra withholding is added after the rate", () => {
  const result = CO_WITHHOLDING.compute({
    payDate: "2026-03-06",
    periodsPerYear: 52,
    wages: "1000.00",
    basis: "resident",
    certificate: cert({ additional_per_period: "25" }),
    federalFilingStatus: "single",
  });
  assert.equal(result.tax, money("64.35"));
});

test("CO accepts the published 260-day basis and refuses unprinted daily periods", () => {
  const daily = CO_WITHHOLDING.compute({
    payDate: "2026-03-06",
    periodsPerYear: 260,
    wages: "1000.00",
    basis: "resident",
    certificate: cert(),
    federalFilingStatus: "single",
  });
  assert.equal(daily.tax, money("43.07"));

  assert.throws(
    () => CO_WITHHOLDING.compute({
      payDate: "2026-03-06",
      periodsPerYear: 365,
      wages: "1000.00",
      basis: "resident",
      certificate: cert(),
      federalFilingStatus: "single",
    }),
    /365 periods a year.*per-period TABLE lookup.*transcribe the state's table for this one/,
  );
});

test("CO W-4-only exempt claim withholds zero; a filed DR 0004 resumes its worksheet", () => {
  const w4Only = CO_WITHHOLDING.compute({
    payDate: "2026-03-06",
    periodsPerYear: 52,
    wages: "1000.00",
    basis: "resident",
    certificate: cert(),
    federalTaxExempt: true,
    stateCertificateOnFile: false,
  });
  assert.equal(w4Only.tax, money("0.00"));

  const withDr0004 = CO_WITHHOLDING.compute({
    payDate: "2026-03-06",
    periodsPerYear: 52,
    wages: "1000.00",
    basis: "resident",
    certificate: cert({ annual_allowance: "0" }),
    federalTaxExempt: true,
    stateCertificateOnFile: true,
  });
  assert.equal(withDr0004.tax, money("44.00"));
});

// DR 1059 and the qualifying-spouse withholding rule:
// https://tax.colorado.gov/sites/tax/files/documents/DR_1059_2023.pdf
// https://tax.colorado.gov/sites/tax/files/documents/ITT_Military_Servicemembers_Feb_2025.pdf
test("CO DR 1059 requires its current-year nonresident military-spouse attestations", () => {
  const incomplete = resolvedCertificate(CO_DR1059_CERTIFICATE, {
    spouse_is_nonresident: "true",
  });
  assert.throws(
    () => CO_WITHHOLDING.compute({
      payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "nonresident",
      certificate: cert(), supportingCertificates: { us_co_dr1059: incomplete },
    }),
    /Colorado military-spouse withholding exemption requires proof that the spouse is a qualifying U.S. servicemember; the servicemember is not a Colorado resident; the spouse is in Colorado solely to be with the servicemember; the servicemember is serving in compliance with military orders; the employee will notify the employer immediately if they become a Colorado resident/,
  );
  const complete = resolvedCertificate(CO_DR1059_CERTIFICATE, Object.fromEntries([
    "spouse_is_nonresident", "servicemember_is_member", "servicemember_is_nonresident",
    "spouse_present_to_accompany", "servicemember_serving_under_orders", "notify_if_residency_changes",
  ].map((key) => [key, "true"])));
  const result = CO_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "nonresident",
    certificate: cert(), supportingCertificates: { us_co_dr1059: complete },
  });
  assert.equal(result.tax, money("0"));
  assert.equal(result.factors.CO_MILITARY_SPOUSE_EXEMPT, "1");
});

test("CO apportions nonresident wages by the verified service-day share", () => {
  // Colorado Wage Withholding Tax Guide (Jan. 2026), Nonresident Employees:
  // Colorado-source wages are the share of pay-period service days worked in CO.
  // https://tax.colorado.gov/sites/tax/files/documents/Wage_Withholding_Tax_Guide_Jan_2026.pdf
  const result = CO_WITHHOLDING.compute({
    payDate: "2026-03-06",
    periodsPerYear: 52,
    wages: "1000.00",
    basis: "nonresident",
    certificate: cert(),
    federalFilingStatus: "single",
    wageAllocations: [{
      region: "CO", subRegion: null, workShare: "0.5", source: "verified Colorado service-day records",
    }],
  });
  // Apportion wages first: $500 × 52 − $5,500 = $20,500; × 4.40% ÷ 52 = $17.35.
  assert.equal(result.factors.CO_NONRESIDENT_WAGES, money("500"));
  assert.equal(result.tax, money("17.35"));
});

test("CO refuses nonresident wages when the service-day allocation is absent", () => {
  assert.throws(
    () => CO_WITHHOLDING.compute({
      payDate: "2026-03-06",
      periodsPerYear: 52,
      wages: "1000.00",
      basis: "nonresident",
      certificate: cert(),
    }),
    /CO\/null needs exactly one current-period work allocation.*Record the work share.*refused by name/,
  );
});

test("CO refuses a year the posted worksheet has not been loaded for", () => {
  assert.throws(
    () => CO_WITHHOLDING.compute({
      payDate: "2027-01-08",
      periodsPerYear: 52,
      wages: "1000.00",
      basis: "resident",
      certificate: cert(),
    }),
    /2027 Colorado income tax withholding tables are not available in this pack version.*update the pack/,
  );
});
