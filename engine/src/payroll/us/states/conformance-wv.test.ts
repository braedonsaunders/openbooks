/**
 * West Virginia withholding CONFORMANCE goldens.
 *
 * IT-100.2A (March 2026) prints percentage-method tables and no worked
 * example. The goldens below are labelled substitutes in the same sense
 * as Ohio and Michigan in conformance-tranche2.test.ts: they are the
 * publication's own printed numbers, or the publication's own arithmetic
 * on those numbers. Nothing here was produced by running the engine and
 * pasting the answer.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  certificateDeclarationProblem, resolveCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
import "../../packs.ts";
import { D, mulRateCents, U } from "../../canada/decimal.ts";
import { pctToRate } from "./transcription.ts";
import { WV_CERTIFICATE, WV_REGION } from "./wv-declaration.ts";
import { WV_RATES_2026, WV_WITHHOLDING, wvPercentageMethod, wvRoundToDollar } from "./wv.ts";

const money = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${(fraction + "0000").slice(0, 4)}`;
};

function cert(answers: Record<string, string> = {}): ResolvedCertificate {
  return resolveCertificate({
    certificate: WV_CERTIFICATE,
    stored: [{ certificateKey: WV_CERTIFICATE.key, answers, effectiveFrom: null }],
  });
}

test("WV certificate and region declarations are well formed", () => {
  assert.equal(certificateDeclarationProblem(WV_CERTIFICATE), null);
  assert.equal(WV_REGION.implemented, true);
  assert.equal(WV_REGION.certificateKey, "us_wv_it104");
});

test("WV IT-100.2A two-earner weekly substitute — $800, 0 exemptions: $25", () => {
  // LABELLED SUBSTITUTE (IT-100.2A prints no worked example).
  // Table 1 weekly, two-earner: $800 is over $577 but not over $866, so
  //   $15.95 plus 4.22% of ($800 − $577) = $15.95 + 4.22% × $223
  //   4.22% × $223 = $9.41; $15.95 + $9.41 = $25.36; nearest dollar = $25.
  const result = WV_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00", basis: "resident",
    certificate: cert({ exemptions: "0" }),
  });
  assert.equal(result.factors.WV_SCHEDULE, "two_earner");
  assert.equal(result.factors.WV_TAXABLE, money("800"));
  assert.equal(result.factors.WV_BAND_OVER, "577");
  assert.equal(D(U("15.95") + mulRateCents(U("223"), pctToRate("4.22"))), money("25.36"));
  assert.equal(result.tax, money("25"));
});

test("WV printed percents and the $2,000 exemption are the publication's own figures", () => {
  assert.equal(WV_RATES_2026.exemptionPerYear, "2000.00");
  assert.equal(WV_RATES_2026.schedules.two_earner.weekly.exemption, "38.46");
  assert.equal(WV_RATES_2026.schedules.two_earner.annual.exemption, "2000.00");
  const weekly = WV_RATES_2026.schedules.two_earner.weekly.rows;
  assert.equal(weekly[0]!.rate, pctToRate("2.11"));
  assert.equal(weekly[1]!.rate, pctToRate("2.81"));
  assert.equal(weekly[2]!.rate, pctToRate("3.16"));
  assert.equal(weekly[3]!.rate, pctToRate("4.22"));
  assert.equal(weekly[4]!.rate, pctToRate("4.58"));
  assert.notEqual(weekly[0]!.rate, pctToRate("2"));
  assert.notEqual(weekly[4]!.rate, pctToRate("6.5"));
  const annual = WV_RATES_2026.schedules.two_earner.annual.rows;
  assert.equal(annual[0]!.upTo, "7500");
  assert.equal(annual[4]!.base, "1462.88");
  assert.notEqual(annual[0]!.upTo, "10000"); // that ceiling is the ONE-earner table
});

test("WV IT-104 line 5 elects the optional one-earner schedule", () => {
  const two = WV_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00", basis: "resident",
    certificate: cert({ exemptions: "0" }),
  });
  const one = WV_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00", basis: "resident",
    certificate: cert({ exemptions: "0", one_earner: "true" }),
  });
  assert.equal(one.factors.WV_SCHEDULE, "one_earner");
  // $800 is over $769 but not over $1,154 on the one-earner weekly table:
  // $21.27 plus 4.22% of ($800 − $769) = $21.27 + $1.31 = $22.58 → $23.
  assert.equal(one.factors.WV_BAND_OVER, "769");
  assert.equal(one.tax, money("23"));
  assert.notEqual(one.tax, two.tax);
});

test("WV with no IT-104 is two-earner, zero exemptions", () => {
  const result = WV_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00", basis: "resident",
    certificate: resolveCertificate({ certificate: WV_CERTIFICATE }),
  });
  assert.equal(result.factors.WV_SCHEDULE, "two_earner");
  assert.equal(result.factors.WV_EXEMPTION, money("0"));
  assert.equal(result.tax, money("25"));
});

test("WV extra withholding is added AFTER dollar rounding", () => {
  const result = WV_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00", basis: "resident",
    certificate: cert({ exemptions: "0", additional_per_period: "10.00" }),
  });
  assert.equal(result.tax, money("35"));
});

test("WV rounds to the dollar, and only at the end", () => {
  assert.equal(D(wvRoundToDollar(U("25.36"))), money("25"));
  assert.equal(D(wvRoundToDollar(U("25.50"))), money("26"));
  // Two exemptions on $400 weekly: taxable $323.08, band $3.04 + 2.81% of $179.08.
  const { tax, factors } = wvPercentageMethod({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "400.00",
    schedule: "two_earner", exemptions: 2,
  });
  assert.equal(factors.WV_EXEMPTION, money("76.92"));
  assert.equal(factors.WV_TAXABLE, money("323.08"));
  assert.equal(D(U("3.04") + mulRateCents(U("179.08"), pctToRate("2.81"))), money("8.07"));
  assert.equal(D(tax), money("8"));
});

test("WV weekly two-earner bases are not a clean annual÷52 — the printed table wins", () => {
  // The annual top-band base $1,462.88 ÷ 52 = $28.1323…; the weekly table
  // prints $28.14. The $829.88 band ÷ 52 = $15.9592…; the weekly table
  // prints $15.95. The engine uses the printed weekly line, not a scaled
  // annual line — the same discipline as Ohio's percentage-method tables.
  assert.equal(WV_RATES_2026.schedules.two_earner.weekly.rows[4]!.base, "28.14");
  assert.notEqual(D(U("1462.88") / 52n), money("28.14"));
  assert.equal(WV_RATES_2026.schedules.two_earner.weekly.rows[3]!.base, "15.95");
});

test("WV refuses a pay frequency it does not print a table for", () => {
  assert.throws(
    () => WV_WITHHOLDING.compute({
      payDate: "2026-03-06", periodsPerYear: 4, wages: "20000",
      basis: "resident", certificate: cert(),
    }),
    /West Virginia income tax publishes withholding tables for/,
  );
});

test("WV IT-104NR exemption stops withholding", () => {
  assert.equal(WV_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "800.00", basis: "resident",
    certificate: cert({ exempt: "true" }),
  }).tax, money("0"));
});

test("WV refuses a year it has not transcribed", () => {
  assert.throws(
    () => WV_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 52, wages: "800",
      basis: "resident", certificate: cert(),
    }),
    /2027 West Virginia income tax withholding tables are not loaded.*Never extrapolate the prior year/s,
  );
});
