/**
 * Minnesota withholding CONFORMANCE goldens.
 *
 * The 2026 booklet prints no worked computer-formula example. Every figure
 * below is either a number printed on p. 34's Step-5 chart, or the booklet's
 * own arithmetic applied to those numbers (annualize × subtract $5,300 ×
 * chart × divide). Nothing here was produced by running the engine and
 * pasting the answer.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  certificateDeclarationProblem, resolveCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
import "../../packs.ts";
import { D, mulRateCents, U } from "../../canada/decimal.ts";
import {
  MN_CERTIFICATE, MN_MWR, MN_REGION, MN_RATES_2026, MN_WITHHOLDING, mnAnnualTax, mnScheduleFor,
  mnSupplementalFlat,
} from "./mn.ts";
import { pctToRate } from "./transcription.ts";

const money = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${(fraction + "0000").slice(0, 4)}`;
};

function cert(answers: Record<string, string> = {}): ResolvedCertificate {
  return resolveCertificate({
    certificate: MN_CERTIFICATE,
    stored: [{ certificateKey: MN_CERTIFICATE.key, answers, effectiveFrom: null }],
  });
}

test("MN certificate and region declarations are well formed", () => {
  assert.equal(certificateDeclarationProblem(MN_CERTIFICATE), null);
  assert.equal(certificateDeclarationProblem(MN_MWR), null);
  assert.equal(MN_REGION.implemented, true);
  assert.equal(MN_REGION.certificateKey, "us_mn_w4mn");
});

test("MN Step-5 chart is the booklet's own digits, converted by shifting the point", () => {
  // 2026 Minnesota Withholding Tax Instructions and Tables, Computer Formula
  // p. 34. Percents as printed; addends as printed.
  assert.equal(MN_RATES_2026.allowance, "5300");
  assert.equal(MN_RATES_2026.dailyPeriods, 360);
  assert.equal(MN_RATES_2026.supplementalRate, pctToRate("6.25"));
  assert.equal(MN_RATES_2026.schedules.single[0]!.rate, pctToRate("5.35"));
  assert.equal(MN_RATES_2026.schedules.single[1]!.add, "1782.09");
  assert.equal(MN_RATES_2026.schedules.single[2]!.add, "6958.25");
  assert.equal(MN_RATES_2026.schedules.single[3]!.add, "14315.27");
  assert.equal(MN_RATES_2026.schedules.married[1]!.add, "2605.45");
  assert.equal(MN_RATES_2026.schedules.married[2]!.add, "12450.49");
  assert.equal(MN_RATES_2026.schedules.married[3]!.add, "23789.82");
});

test("MN Step-5 addends ARE the tax on everything below each band", () => {
  // A transcription slip in a rate or a threshold shows up here.
  const [s0, s1, s2, s3] = MN_RATES_2026.schedules.single;
  assert.equal(
    D(mulRateCents(U(s1!.moreThan) - U(s0!.subtract), s0!.rate)),
    money(s1!.add),
  );
  assert.equal(
    D(U(s1!.add) + mulRateCents(U(s2!.moreThan) - U(s1!.subtract), s1!.rate)),
    money(s2!.add),
  );
  assert.equal(
    D(U(s2!.add) + mulRateCents(U(s3!.moreThan) - U(s2!.subtract), s2!.rate)),
    money(s3!.add),
  );

  const [m0, m1, m2, m3] = MN_RATES_2026.schedules.married;
  assert.equal(
    D(mulRateCents(U(m1!.moreThan) - U(m0!.subtract), m0!.rate)),
    money(m1!.add),
  );
  assert.equal(
    D(U(m1!.add) + mulRateCents(U(m2!.moreThan) - U(m1!.subtract), m1!.rate)),
    money(m2!.add),
  );
  assert.equal(
    D(U(m2!.add) + mulRateCents(U(m3!.moreThan) - U(m2!.subtract), m2!.rate)),
    money(m3!.add),
  );
});

test("MN computer formula — weekly $1,000, single, 1 allowance: $45.63", () => {
  // Step 2: $1,000 × 52 = $52,000.
  // Step 3: 1 × $5,300 = $5,300.
  // Step 4: $46,700.
  // Step 5 (single, more than $38,010 but not more than $114,130):
  //   $1,782.09 + 6.80% × ($46,700 − $38,010) = $1,782.09 + $590.92 = $2,373.01.
  // Step 6: $2,373.01 ÷ 52 = $45.63.
  const result = MN_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "resident",
    certificate: cert({ marital_status: "single", allowances: "1" }),
  });
  assert.equal(result.factors.MN_ANNUAL_WAGES, money("52000"));
  assert.equal(result.factors.MN_ANNUAL_ALLOWANCE, money("5300"));
  assert.equal(result.factors.MN_TAXABLE, money("46700"));
  assert.equal(result.factors.MN_ANNUAL_TAX, money("2373.01"));
  assert.equal(result.tax, money("45.63"));
});

test("MN withholds nothing at or below the first 'More than', and daily uses 360", () => {
  // Step 4 at or below $4,700 single: "If zero or less, stop here" plus the
  // chart's exclusive floor. $90 a week is $4,680 a year.
  const below = MN_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "90.00", basis: "resident",
    certificate: cert({ marital_status: "single", allowances: "0" }),
  });
  assert.equal(below.factors.MN_TAXABLE, money("4680"));
  assert.equal(below.tax, money("0"));

  // Daily $100, single, 0 allowances: $100 × 360 = $36,000; 5.35% of
  // ($36,000 − $4,700) = $1,674.55; ÷ 360 = $4.65. Using 365 would be a
  // different cent.
  const daily = MN_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 360, wages: "100.00", basis: "resident",
    certificate: cert({ marital_status: "single" }),
  });
  assert.equal(daily.factors.MN_ANNUAL_WAGES, money("36000"));
  assert.equal(daily.factors.MN_ANNUAL_TAX, money("1674.55"));
  assert.equal(daily.tax, money("4.65"));
});

test("MN married chart, extra withholding after the rate, and the no-certificate default", () => {
  // $2,000 biweekly, married, 2 allowances: $52,000 − $10,600 = $41,400.
  // Married, more than $14,700 but not more than $63,400:
  //   5.35% × ($41,400 − $14,700) = $1,428.45; ÷ 26 = $54.94.
  const married = MN_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 26, wages: "2000.00", basis: "resident",
    certificate: cert({ marital_status: "married", allowances: "2" }),
  });
  assert.equal(married.factors.MN_SCHEDULE, "married");
  assert.equal(married.factors.MN_TAXABLE, money("41400"));
  assert.equal(married.tax, money("54.94"));

  const extra = MN_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 26, wages: "2000.00", basis: "resident",
    certificate: cert({
      marital_status: "married", allowances: "2", additional_per_period: "25.00",
    }),
  });
  assert.equal(extra.tax, money("79.94"));

  // W-4MN: no form → single, zero allowances.
  const none = MN_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "resident",
    certificate: resolveCertificate({ certificate: MN_CERTIFICATE }),
  });
  assert.equal(none.factors.MN_SCHEDULE, "single");
  assert.equal(none.factors.MN_ANNUAL_ALLOWANCE, money("0"));
  assert.equal(mnScheduleFor("married_higher_single"), "single");
});

test("MN Section 2 exempt stops withholding; Method 2 supplemental is a flat 6.25%", () => {
  const exempt = MN_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "resident",
    certificate: cert({ exempt: "true" }),
  });
  assert.equal(exempt.tax, money("0"));

  // Booklet p. 7 Method 2: multiply the supplemental by 6.25%.
  assert.equal(mnSupplementalFlat("2026-03-15", "4000.00"), money("250"));
  // compute aggregates (Method 1).
  const withBonus = MN_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", supplemental: "4000.00",
    basis: "resident", certificate: cert({ marital_status: "single" }),
  });
  assert.equal(withBonus.factors.MN_ANNUAL_WAGES, money("260000"));
  assert.ok(U(withBonus.tax) > U("45.63"));
});

test("MN refuses a year it has not transcribed", () => {
  assert.throws(
    () => MN_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 52, wages: "1000", basis: "resident",
      certificate: cert(),
    }),
    /2027 Minnesota income tax withholding tables are not loaded.*Never extrapolate the prior year/s,
  );
  assert.equal(D(mnAnnualTax(U("4700"), "single", MN_RATES_2026)), money("0"));
});
