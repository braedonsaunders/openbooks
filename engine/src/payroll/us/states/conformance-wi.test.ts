/**
 * Wisconsin withholding CONFORMANCE goldens.
 *
 * Every expected figure is transcribed from Publication W-166 (January 2026)
 * pp. 25–26, Examples 1–3, or is the publication's own schedule of tax rates
 * re-derived from those rates. Nothing here was produced by running the engine
 * and pasting the answer.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  certificateDeclarationProblem, resolveCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
import "../../packs.ts";
import { D, mulRateCents, U } from "../../canada/decimal.ts";
import {
  WI_CERTIFICATE, WI_REGION, WI_W220, WI_RATES_2026, WI_WITHHOLDING, wiAnnualTax, wiDeduction,
  wiScheduleFor,
} from "./wi.ts";
import { pctToRate } from "./transcription.ts";
import { money, resolvedCertificate } from "./conformance-support.ts";

const cert = (answers: Record<string, string> = {}): ResolvedCertificate =>
  resolvedCertificate(WI_CERTIFICATE, answers);

test("WI certificate and region declarations are well formed", () => {
  assert.equal(certificateDeclarationProblem(WI_CERTIFICATE), null);
  assert.equal(certificateDeclarationProblem(WI_W220), null);
  assert.equal(WI_REGION.implemented, true);
  assert.equal(WI_REGION.certificateKey, "us_wi_wt4");
});

test("WI Example 1 — weekly $350, single, 1 exemption: $7.59", () => {
  // W-166 p. 25: (a) $350 × 52 = $18,200.00
  // (b) $6,702.00 − 12% × ($18,200 − $17,780) = $6,702.00 − $50.40 = $6,651.60
  // (c) $18,200.00 − $6,651.60 = $11,548.40
  // (d)–(e) $400.00 → annual net $11,148.40
  // (f) $11,148.40 at 3.54% = $394.65
  // (g) $394.65 ÷ 52 = $7.59
  const result = WI_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "350.00", basis: "resident",
    certificate: cert({ marital_status: "single", exemptions: "1" }),
  });
  assert.equal(result.factors.WI_ANNUAL_GROSS, money("18200"));
  assert.equal(result.factors.WI_DEDUCTION, money("6651.60"));
  assert.equal(result.factors.WI_ANNUAL_NET, money("11148.40"));
  assert.equal(result.factors.WI_ANNUAL_TAX, money("394.65"));
  assert.equal(result.tax, money("7.59"));
});

test("WI Example 2 — weekly $500, single, 3 exemptions: $14.34", () => {
  // W-166 p. 26: (a) $26,000.00
  // (b) $6,702.00 − 12% × ($26,000 − $17,780) = $6,702.00 − $986.40 = $5,715.60
  // (c) $20,284.40; (d)–(e) $1,200.00 → $19,084.40
  // (f) tax on $12,760 = $451.70; 4.65% × $6,324.40 = $294.08; total $745.78
  // (g) $745.78 ÷ 52 = $14.34
  const result = WI_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "500.00", basis: "resident",
    certificate: cert({ marital_status: "single", exemptions: "3" }),
  });
  assert.equal(result.factors.WI_DEDUCTION, money("5715.60"));
  assert.equal(result.factors.WI_ANNUAL_NET, money("19084.40"));
  assert.equal(result.factors.WI_ANNUAL_TAX, money("745.78"));
  assert.equal(result.tax, money("14.34"));
});

test("WI Example 3 — biweekly $1,000, married, 3 exemptions: $22.08", () => {
  // W-166 p. 26: (a) $1,000 × 26 = $26,000.00
  // (b) $9,461.00 − 20% × ($26,000 − $25,727) = $9,461.00 − $54.60 = $9,406.40
  // (c) $16,593.60; (d)–(e) $1,200.00 → $15,393.60
  // (f) tax on $12,760 = $451.70; 4.65% × $2,633.60 = $122.46; total $574.16
  // (g) $574.16 ÷ 26 = $22.08
  const result = WI_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 26, wages: "1000.00", basis: "resident",
    certificate: cert({ marital_status: "married", exemptions: "3" }),
  });
  assert.equal(result.factors.WI_SCHEDULE, "married");
  assert.equal(result.factors.WI_DEDUCTION, money("9406.40"));
  assert.equal(result.factors.WI_ANNUAL_NET, money("15393.60"));
  assert.equal(result.factors.WI_ANNUAL_TAX, money("574.16"));
  assert.equal(result.tax, money("22.08"));
});

test("WI schedule of tax rates is internally consistent", () => {
  // Printed: 3.54% of the amount; $451.70 + 4.65% of excess over $12,760;
  // $1,045.04 + 5.30% of excess over $25,520; $14,582.83 + 7.65% of excess
  // over $280,950.
  assert.equal(WI_RATES_2026.exemption, "400");
  assert.equal(WI_RATES_2026.brackets[0]!.rate, pctToRate("3.54"));
  assert.equal(D(mulRateCents(U("12760"), pctToRate("3.54"))), money("451.70"));
  assert.equal(
    D(U("451.70") + mulRateCents(U("25520") - U("12760"), pctToRate("4.65"))),
    money("1045.04"),
  );
  assert.equal(
    D(U("1045.04") + mulRateCents(U("280950") - U("25520"), pctToRate("5.30"))),
    money("14582.83"),
  );
  // The phase-out hits zero exactly at the printed end:
  // $6,702 − 12% × ($73,630 − $17,780) = $6,702 − $6,702.
  assert.equal(D(wiDeduction(U("73630"), "single", WI_RATES_2026)), money("0"));
  assert.equal(D(wiDeduction(U("17779.99"), "single", WI_RATES_2026)), money("6702"));
  assert.equal(D(wiDeduction(U("73032"), "married", WI_RATES_2026)), money("0"));
});

test("WI line 2 is added AFTER the formula, and no WT-4 means zero exemptions", () => {
  const extra = WI_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "350.00", basis: "resident",
    certificate: cert({
      marital_status: "single", exemptions: "1", additional_per_period: "10.00",
    }),
  });
  assert.equal(extra.tax, money("17.59"));

  const none = WI_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "350.00", basis: "resident",
    certificate: resolveCertificate({ certificate: WI_CERTIFICATE }),
  });
  assert.equal(none.factors.WI_SCHEDULE, "single");
  assert.equal(none.factors.WI_EXEMPTION, money("0"));
  assert.equal(wiScheduleFor("married_higher_single"), "single");

  const exempt = WI_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "350.00", basis: "resident",
    certificate: cert({ exempt: "true" }),
  });
  assert.equal(exempt.tax, money("0"));
});

test("WI refuses a year it has not transcribed", () => {
  assert.throws(
    () => WI_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 52, wages: "1000", basis: "resident",
      certificate: cert(),
    }),
    /2027 Wisconsin income tax withholding tables are not loaded.*Never extrapolate the prior year/s,
  );
  assert.equal(D(wiAnnualTax(0n, WI_RATES_2026)), money("0"));
});
