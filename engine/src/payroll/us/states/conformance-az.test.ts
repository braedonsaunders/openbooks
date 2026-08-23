/**
 * Arizona withholding CONFORMANCE goldens — Form A-4 2026.
 *
 * Arizona publishes no dollar-and-cents worked example. The goldens below are
 * the form's own arithmetic (a printed percent of gross taxable wages, plus
 * any extra amount), labelled as such. Nothing was produced by running the
 * engine and pasting the answer.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  certificateDeclarationProblem, resolveCertificate, type ResolvedCertificate,
} from "../../certificates.ts";
import "../../packs.ts";
import {
  AZ_CERTIFICATE, AZ_REGION, AZ_PRINTED_PERCENTS, AZ_RATES_2026, AZ_WITHHOLDING,
  azRateForPrintedPercent,
} from "./az.ts";
import { pctToRate } from "./transcription.ts";
import { money, resolvedCertificate } from "./conformance-support.ts";

const cert = (answers: Record<string, string> = {}): ResolvedCertificate =>
  resolvedCertificate(AZ_CERTIFICATE, answers);

test("AZ certificate and region declarations are well formed", () => {
  assert.equal(certificateDeclarationProblem(AZ_CERTIFICATE), null);
  assert.equal(AZ_REGION.implemented, true);
  assert.equal(AZ_REGION.certificateKey, "us_az_a4");
});

test("AZ printed percents convert by shifting the point, not dividing", () => {
  assert.equal(azRateForPrintedPercent("0.5"), pctToRate("0.5"));
  assert.equal(azRateForPrintedPercent("2.0"), "0.020");
  assert.equal(azRateForPrintedPercent("2.5"), "0.025");
  assert.equal(azRateForPrintedPercent("3.5"), "0.035");
  assert.deepEqual([...AZ_PRINTED_PERCENTS], [
    "0.5", "1.0", "1.5", "2.0", "2.5", "3.0", "3.5",
  ]);
  assert.equal(AZ_RATES_2026.defaultPrintedPercent, "2.0");
});

test("AZ Form A-4 — 2.0% of $1,000.00 gross taxable wages: $20.00", () => {
  // Form A-4 2026: "The amount withheld is a percentage of your gross taxable
  // wages from every paycheck." 2.0% is both a line-1 box and ADOR's
  // prescribed default when no A-4 is on file.
  const result = AZ_WITHHOLDING.compute({
    payDate: "2026-03-13", periodsPerYear: 26, wages: "1000.00", basis: "resident",
    certificate: cert({ withholding_percent: "2.0" }),
  });
  assert.equal(result.factors.AZ_PRINTED_PERCENT, "2.0");
  assert.equal(result.factors.AZ_RATE, "0.020");
  assert.equal(result.tax, money("20"));
});

test("AZ Form A-4 — 2.5% of $2,400.00: $60.00", () => {
  // 2.5% is the statutory individual income-tax rate ADOR prints beside the
  // withholding percents ("for tax year 2023 and beyond, the tax rate … is
  // 2.5%"). It is an allowed line-1 election, not a default.
  const result = AZ_WITHHOLDING.compute({
    payDate: "2026-03-13", periodsPerYear: 26, wages: "2400.00", basis: "resident",
    certificate: cert({ withholding_percent: "2.5" }),
  });
  assert.equal(result.tax, money("60"));
});

test("AZ Form A-4 line 1 extra amount is added AFTER the percent", () => {
  const result = AZ_WITHHOLDING.compute({
    payDate: "2026-03-13", periodsPerYear: 26, wages: "1000.00", basis: "resident",
    certificate: cert({ withholding_percent: "2.0", additional_per_period: "15.00" }),
  });
  assert.equal(result.factors.AZ_TAX, money("20"));
  assert.equal(result.factors.AZ_EXTRA, money("15"));
  assert.equal(result.tax, money("35"));
});

test("AZ no A-4 on file withholds the form's stated 2.0% default", () => {
  // A.R.S. § 43-401(E) / ADOR: deemed to have elected the department's
  // prescribed percentage, which ADOR states as 2.0%. The default is on the
  // certificate, not invented here.
  const result = AZ_WITHHOLDING.compute({
    payDate: "2026-03-13", periodsPerYear: 26, wages: "1000.00", basis: "resident",
    certificate: resolveCertificate({ certificate: AZ_CERTIFICATE }),
  });
  assert.equal(result.factors.AZ_PRINTED_PERCENT, "2.0");
  assert.equal(result.tax, money("20"));
});

test("AZ Form A-4 line 2 zero election withholds nothing", () => {
  const result = AZ_WITHHOLDING.compute({
    payDate: "2026-03-13", periodsPerYear: 26, wages: "1000.00", basis: "resident",
    certificate: cert({ withholding_percent: "3.5", zero_percent: "true" }),
  });
  assert.equal(result.tax, money("0"));
  assert.equal(result.factors.AZ_ZERO, "1");
});

test("AZ is a percent of wages at any pay frequency", () => {
  const weekly = AZ_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 52, wages: "1000.00", basis: "resident",
    certificate: cert({ withholding_percent: "2.0" }),
  });
  const odd = AZ_WITHHOLDING.compute({
    payDate: "2026-03-06", periodsPerYear: 13, wages: "1000.00", basis: "resident",
    certificate: cert({ withholding_percent: "2.0" }),
  });
  assert.equal(weekly.tax, money("20"));
  assert.equal(odd.tax, money("20"));
  assert.equal(AZ_WITHHOLDING.printedPeriods, null);
});

test("AZ refuses a year it has not transcribed, and never extrapolates", () => {
  assert.throws(
    () => AZ_WITHHOLDING.compute({
      payDate: "2027-01-15", periodsPerYear: 26, wages: "1000", basis: "resident",
      certificate: cert(),
    }),
    /2027 Arizona income tax withholding tables are not loaded.*Never extrapolate the prior year/s,
  );
});
