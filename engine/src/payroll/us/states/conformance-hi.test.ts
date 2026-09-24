/**
 * Hawaii withholding CONFORMANCE goldens.
 *
 * Every expected figure is transcribed from Booklet A (Rev. 2025) or is that
 * publication's own arithmetic on its own printed numbers.
 * HW-4 status declarations and the non-withholding eligibility conditions are
 * transcribed from HW-4 (Rev. 2022) and Booklet A, section 11(b), (g):
 * https://files.hawaii.gov/tax/forms/current/hw4_i.pdf
 * https://files.hawaii.gov/tax/news/pubs/25BkltA.pdf
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  certificateAnswersProblem, certificateDeclarationProblem, resolveCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
import "../../packs.ts";
import { D, mulRateCents, U } from "../../canada/decimal.ts";
import { HI_CERTIFICATE, HI_REGION, HI_RATES_2026, HI_WITHHOLDING, hiAnnualTax } from "./hi.ts";
import { pctToRate } from "./transcription.ts";
import { money, resolvedCertificate } from "./conformance-support.ts";

const cert = (answers: Record<string, string> = {}): ResolvedCertificate =>
  resolvedCertificate(HI_CERTIFICATE, answers);

test("HI certificate and region declarations are well formed", () => {
  assert.equal(certificateDeclarationProblem(HI_CERTIFICATE), null);
  assert.equal(HI_REGION.implemented, true);
  assert.equal(HI_REGION.certificateKey, "us_hi_hw4");
});

test("HI printed percents and the booklet's $3,818 remainder", () => {
  assert.equal(pctToRate("5.50"), "0.0550");
  assert.equal(D(mulRateCents(U("3818"), pctToRate("5.50"))), money("209.99"));
  assert.equal(hiAnnualTax(U("18218"), false, HI_RATES_2026), U("497.99"));
});

test("HI Booklet A example — $500 weekly, single, 3 allowances: $9.58", () => {
  // $500 × 52 = $26,000. Allowances 3 × $1,144 = $3,432. Lump-sum $4,350.
  // Taxable $18,218. $288 + $3,818 × 5.5% = $497.99. $497.99 ÷ 52 = $9.58.
  const result = HI_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00",
    basis: "resident", certificate: cert({ filing_status: "single", allowances: "3" }),
  });
  assert.equal(result.factors.HI_ANNUAL_WAGES, money("26000"));
  assert.equal(result.factors.HI_ALLOWANCES, money("3432"));
  assert.equal(result.factors.HI_LUMP_SUM, money("4350"));
  assert.equal(result.factors.HI_TAXABLE, money("18218"));
  assert.equal(result.factors.HI_ANNUAL_TAX, money("497.99"));
  assert.equal(result.tax, money("9.58"));
});

test("HI married employees can elect withholding at the higher Single rate", () => {
  // HW-4 (Rev. 2022) distinct status; Booklet A's 2026 annualized schedules.
  const answers = { filing_status: "married_single_rate" };
  assert.equal(certificateAnswersProblem(HI_CERTIFICATE, answers), null);
  const single = HI_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00",
    basis: "resident", certificate: cert({ filing_status: "single" }),
  });
  const elected = HI_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00",
    basis: "resident", certificate: cert(answers),
  });
  const married = HI_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00",
    basis: "resident", certificate: cert({ filing_status: "married" }),
  });
  assert.equal(elected.tax, money("13.63"));
  assert.equal(elected.tax, single.tax);
  assert.equal(married.tax, money("6.68"));
  assert.ok(U(elected.tax) > U(married.tax));
});

test("HI no HW-4 withholds as single with zero allowances", () => {
  const empty = HI_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00",
    basis: "resident", certificate: resolveCertificate({ certificate: HI_CERTIFICATE }),
  });
  const singleZero = HI_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00",
    basis: "resident", certificate: cert({ filing_status: "single", allowances: "0" }),
  });
  assert.equal(empty.tax, singleZero.tax);
  assert.equal(empty.factors.HI_ALLOWANCES, money("0"));
});

test("HI extra withholding is added and HW-4 has no generic exempt status", () => {
  assert.equal(HI_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00",
    basis: "resident",
    certificate: cert({ filing_status: "single", allowances: "3", additional_per_period: "5.00" }),
  }).tax, money("14.58"));
  assert.equal(HI_CERTIFICATE.fields.some((field) => field.key === "exempt"), false);
});

test("HI certified-disabled status requires the Department certification on file", () => {
  assert.throws(
    () => HI_WITHHOLDING.compute({
      payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00", basis: "resident",
      certificate: cert({ filing_status: "certified_disabled" }),
    }),
    /Hawaii certified-disabled withholding status requires the Department-prescribed disability certification on file/,
  );
  assert.equal(HI_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00",
    basis: "resident",
    certificate: cert({ filing_status: "certified_disabled", disability_certification_on_file: "true" }),
  }).factors.HI_CERTIFIED_DISABLED_NOT_SUBJECT, "1");
  assert.equal(HI_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00", basis: "resident",
    certificate: cert({ filing_status: "certified_disabled", disability_certification_on_file: "true" }),
  }).tax, money("0"));
});

test("HI nonresident military-spouse status requires all statutory eligibility facts", () => {
  assert.throws(
    () => HI_WITHHOLDING.compute({
      payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00", basis: "resident",
      certificate: cert({ filing_status: "nonresident_military_spouse" }),
    }),
    /Hawaii military-spouse withholding exemption requires proof that the servicemember is in Hawaii solely under military or naval orders; the spouse is in Hawaii solely to be with the servicemember; the spouse and servicemember are domiciled in the same state outside Hawaii/,
  );
  const militarySpouse = HI_WITHHOLDING.compute({
    payDate: "2026-03-15", periodsPerYear: 52, wages: "500.00", basis: "resident",
    certificate: cert({
      filing_status: "nonresident_military_spouse",
      servicemember_present_under_orders: "true",
      spouse_present_to_accompany: "true",
      same_non_hawaii_domicile: "true",
    }),
  });
  assert.equal(militarySpouse.tax, money("0"));
  assert.equal(militarySpouse.factors.HI_NONRESIDENT_MILITARY_SPOUSE_NOT_SUBJECT, "1");
});

test("HI refuses a year it has not transcribed", () => {
  assert.throws(
    () => HI_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 52, wages: "500",
      basis: "resident", certificate: cert({ filing_status: "single", allowances: "3" }),
    }),
    /2027 Hawaii income tax withholding tables are not available in this pack version.*update the pack.*Never extrapolate the prior year/s,
  );
});
