/**
 * Utah withholding CONFORMANCE goldens — Publication 14 worked examples.
 *
 * Every expected figure is transcribed from Pub 14's own examples (p. 11),
 * with the revision, the example label and the printed inputs beside it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { certificateDeclarationProblem, type ResolvedCertificate } from "../../certificates.ts";
import "../../packs.ts";
import {
  UT_CERTIFICATE, UT_REGION, UT_EDITION_2025, UT_EDITION_2026, UT_WITHHOLDING, utScheduleFor,
} from "./ut.ts";
import { pctToRate } from "./transcription.ts";
import { money, resolvedCertificate } from "./conformance-support.ts";

const cert = (answers: Record<string, string> = {}): ResolvedCertificate =>
  resolvedCertificate(UT_CERTIFICATE, answers);

test("UT certificate and region declarations are well formed", () => {
  assert.equal(certificateDeclarationProblem(UT_CERTIFICATE), null);
  assert.equal(UT_REGION.implemented, true);
  assert.equal(UT_REGION.certificateKey, "us_ut_w4");
});

test("UT printed percents convert by shifting the point, not dividing", () => {
  assert.equal(UT_EDITION_2026.rate, pctToRate("4.45"));
  assert.equal(UT_EDITION_2026.phaseoutRate, pctToRate("1.3"));
  assert.equal(UT_EDITION_2025.rate, pctToRate("4.5"));
  assert.equal(pctToRate("4.45"), "0.0445");
  assert.equal(pctToRate("4.5"), "0.045");
});

/* ===================================================================== */
/* Publication 14 (Rev. 4/26) — examples, p. 11, pay dates on/after 6/1 */
/* ===================================================================== */

test("UT Example 1 — weekly $400, Single: $12 (Rev. 4/26 p. 11)", () => {
  // Schedule 1, Weekly/Single. Printed lines:
  //   1. 400   2. 18   3. 9   4. 220   5. 3   6. 6   7. 12
  const result = UT_WITHHOLDING.compute({
    payDate: "2026-06-05", periodStart: "2026-06-01", periodsPerYear: 52, wages: "400.00", basis: "resident",
    certificate: cert({ filing_status: "single" }),
  });
  assert.equal(result.factors.UT_LINE2, money("18"));
  assert.equal(result.factors.UT_BASE_ALLOWANCE, money("9"));
  assert.equal(result.factors.UT_LINE4, money("220"));
  assert.equal(result.factors.UT_LINE5, money("3"));
  assert.equal(result.factors.UT_LINE6, money("6"));
  assert.equal(result.tax, money("12"));
});

test("UT Example 2 — biweekly $2,600, Single: $116 (Rev. 4/26 p. 11)", () => {
  // Schedule 2, Biweekly/Single. Printed lines:
  //   1. 2600   2. 116   3. 19   4. 2240   5. 29   6. 0   7. 116
  const result = UT_WITHHOLDING.compute({
    payDate: "2026-06-12", periodStart: "2026-06-01", periodsPerYear: 26, wages: "2600.00", basis: "resident",
    certificate: cert({ filing_status: "single" }),
  });
  assert.equal(result.factors.UT_LINE2, money("116"));
  assert.equal(result.factors.UT_BASE_ALLOWANCE, money("19"));
  assert.equal(result.factors.UT_LINE4, money("2240"));
  assert.equal(result.factors.UT_LINE5, money("29"));
  assert.equal(result.factors.UT_LINE6, money("0"));
  assert.equal(result.tax, money("116"));
});

test("UT Example 3 — semimonthly $1,200, Married: $18 (Rev. 4/26 p. 11)", () => {
  // Schedule 3, Semimonthly/Married. Printed lines:
  //   1. 1200   2. 53   3. 40   4. 421   5. 5   6. 35   7. 18
  const result = UT_WITHHOLDING.compute({
    payDate: "2026-06-15", periodStart: "2026-06-01", periodsPerYear: 24, wages: "1200.00", basis: "resident",
    certificate: cert({ filing_status: "married" }),
  });
  assert.equal(result.factors.UT_LINE2, money("53"));
  assert.equal(result.factors.UT_BASE_ALLOWANCE, money("40"));
  assert.equal(result.factors.UT_LINE4, money("421"));
  assert.equal(result.factors.UT_LINE5, money("5"));
  assert.equal(result.factors.UT_LINE6, money("35"));
  assert.equal(result.tax, money("18"));
});

test("UT Example 4 — monthly $7,800, Married: $347 (Rev. 4/26 p. 11)", () => {
  // Schedule 4, Monthly/Married. Printed lines:
  //   1. 7800   2. 347   3. 81   4. 6242   5. 81   6. 0   7. 347
  const result = UT_WITHHOLDING.compute({
    payDate: "2026-06-30", periodStart: "2026-06-01", periodsPerYear: 12, wages: "7800.00", basis: "resident",
    certificate: cert({ filing_status: "married" }),
  });
  assert.equal(result.factors.UT_LINE2, money("347"));
  assert.equal(result.factors.UT_BASE_ALLOWANCE, money("81"));
  assert.equal(result.factors.UT_LINE4, money("6242"));
  assert.equal(result.factors.UT_LINE5, money("81"));
  assert.equal(result.factors.UT_LINE6, money("0"));
  assert.equal(result.tax, money("347"));
});

test("UT Example 5 — quarterly $9,000, Single: $367 (Rev. 4/26 p. 11)", () => {
  // Schedule 5, Quarterly/Single. Printed lines:
  //   1. 9000   2. 401   3. 121   4. 6663   5. 87   6. 34   7. 367
  // 9000 × .0445 = 400.50, printed as 401 — the dollar-rounding pin.
  const result = UT_WITHHOLDING.compute({
    payDate: "2026-06-30", periodStart: "2026-06-01", periodsPerYear: 4, wages: "9000.00", basis: "resident",
    certificate: cert({ filing_status: "single" }),
  });
  assert.equal(result.factors.UT_LINE2, money("401"));
  assert.equal(result.factors.UT_BASE_ALLOWANCE, money("121"));
  assert.equal(result.factors.UT_LINE4, money("6663"));
  assert.equal(result.factors.UT_LINE5, money("87"));
  assert.equal(result.factors.UT_LINE6, money("34"));
  assert.equal(result.tax, money("367"));
});

test("UT Example 6 — daily $175, Married: $5 (Rev. 4/26 p. 11)", () => {
  // Schedule 8, Daily/Married. Printed lines:
  //   1. 175   2. 8   3. 4   4. 103   5. 1   6. 3   7. 5
  const result = UT_WITHHOLDING.compute({
    payDate: "2026-06-05", periodStart: "2026-06-01", periodsPerYear: 260, wages: "175.00", basis: "resident",
    certificate: cert({ filing_status: "married" }),
  });
  assert.equal(result.factors.UT_LINE2, money("8"));
  assert.equal(result.factors.UT_BASE_ALLOWANCE, money("4"));
  assert.equal(result.factors.UT_LINE4, money("103"));
  assert.equal(result.factors.UT_LINE5, money("1"));
  assert.equal(result.factors.UT_LINE6, money("3"));
  assert.equal(result.tax, money("5"));
});

/* ===================================================================== */
/* Publication 14 (Rev. 4/25) — still effective through 31 May 2026      */
/* ===================================================================== */

test("UT Rev. 4/25 Example 2 — biweekly $2,600, Single: $117 (p. 11)", () => {
  // Same facts as the June Example 2, different rate. Printed lines:
  //   1. 2600   2. 117   3. 17   4. 2250   5. 29   6. 0   7. 117
  const result = UT_WITHHOLDING.compute({
    payDate: "2026-03-13", periodStart: "2026-03-01", periodsPerYear: 26, wages: "2600.00", basis: "resident",
    certificate: cert({ filing_status: "single" }),
  });
  assert.equal(result.factors.UT_EDITION, "2026-01-01");
  assert.equal(result.factors.UT_LINE2, money("117"));
  assert.equal(result.factors.UT_BASE_ALLOWANCE, money("17"));
  assert.equal(result.factors.UT_LINE4, money("2250"));
  assert.equal(result.tax, money("117"));
});

test("UT mid-year cut uses payroll period start, not pay date", () => {
  // Pub 14 Rev. 4/26: tables apply to pay periods beginning on or after
  // June 1, 2026. A period beginning May 31 but paid after June 1 remains on
  // Rev. 4/25; a period beginning June 1 uses Rev. 4/26.
  const may = UT_WITHHOLDING.compute({
    payDate: "2026-06-12", periodStart: "2026-05-31", periodsPerYear: 26, wages: "2600.00", basis: "resident",
    certificate: cert({ filing_status: "single" }),
  });
  const june = UT_WITHHOLDING.compute({
    payDate: "2026-06-12", periodStart: "2026-06-01", periodsPerYear: 26, wages: "2600.00", basis: "resident",
    certificate: cert({ filing_status: "single" }),
  });
  assert.equal(may.tax, money("117"));
  assert.equal(june.tax, money("116"));
});

test("UT refuses to infer the period start from the pay date", () => {
  assert.throws(
    () => UT_WITHHOLDING.compute({
      payDate: "2026-06-12", periodsPerYear: 26, wages: "2600.00", basis: "resident",
      certificate: cert({ filing_status: "single" }),
    }),
    /keyed to the PAYROLL PERIOD START DATE, not the pay date/s,
  );
});

test("UT head of household uses the Single column (tables footnote p. 12)", () => {
  assert.equal(utScheduleFor("head_household"), "single");
  const result = UT_WITHHOLDING.compute({
    payDate: "2026-06-05", periodStart: "2026-06-01", periodsPerYear: 52, wages: "400.00", basis: "resident",
    certificate: cert({ filing_status: "head_household" }),
  });
  assert.equal(result.factors.UT_SCHEDULE, "single");
  assert.equal(result.tax, money("12"));
});

test("UT exempt W-4 notation withholds nothing", () => {
  const result = UT_WITHHOLDING.compute({
    payDate: "2026-06-05", periodStart: "2026-06-01", periodsPerYear: 52, wages: "400.00", basis: "resident",
    certificate: cert({ filing_status: "single", exempt: "true" }),
  });
  assert.equal(result.tax, money("0"));
  assert.equal(result.factors.UT_EXEMPT, "1");
});

test("UT refuses a pay frequency it prints no schedule for", () => {
  assert.throws(
    () => UT_WITHHOLDING.compute({
      payDate: "2026-06-05", periodStart: "2026-06-01", periodsPerYear: 13, wages: "2000", basis: "resident",
      certificate: cert(),
    }),
    /publishes withholding tables for .*there is nothing to scale/s,
  );
});

test("UT refuses a year it has not transcribed, and never extrapolates", () => {
  assert.throws(
    () => UT_WITHHOLDING.compute({
      payDate: "2027-01-15", periodStart: "2027-01-01", periodsPerYear: 26, wages: "2000", basis: "resident",
      certificate: cert(),
    }),
    /2027 Utah income tax withholding tables are not loaded.*Never extrapolate the prior year/s,
  );
});
