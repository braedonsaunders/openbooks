import assert from "node:assert/strict";
import test from "node:test";
import { cmp } from "../money/money.ts";
import {
  MacrsShortYearError,
  assertShortYearFactorAgrees,
  decliningBalanceRate,
  formatCalendarDay,
  halfYearDeemedServiceDate,
  impliedShortYearFactor,
  isFullTaxYear,
  isShortTaxYear,
  midQuarterDeemedServiceDate,
  monthsTreatedInService,
  shortTaxYearMonths,
  shortYearPlacementDeduction,
  subsequentRecoveryDeduction,
} from "./macrs-short-year.ts";

test("Pub 946 counts March 15–December 31 as ten months", () => {
  assert.equal(shortTaxYearMonths("2023-03-15", "2023-12-31"), 10);
  assert.equal(shortTaxYearMonths("2023-01-01", "2023-06-30"), 6);
});

test("full fiscal years require twelve full months, not twelve touched months", () => {
  assert.equal(isFullTaxYear("2025-07-01", "2026-06-30"), true);
  assert.equal(isFullTaxYear("2024-01-01", "2024-12-31"), true);
  assert.equal(isShortTaxYear("2026-01-15", "2026-12-31"), true);
  assert.equal(isShortTaxYear("2026-01-01", "2026-12-15"), true);
  assert.throws(
    () => isFullTaxYear("2026-07-01", "2026-06-30"),
    /ends before it starts/,
  );
});

test("four- and eight-full-month years use calendar quarters, including leap February", () => {
  assert.equal(
    formatCalendarDay(
      midQuarterDeemedServiceDate("2024-02-01", "2024-05-31", "2024-03-01"),
    ),
    "2024-03-15",
  );
  assert.equal(
    formatCalendarDay(
      midQuarterDeemedServiceDate("2026-01-01", "2026-08-31", "2026-03-01"),
    ),
    "2026-04-01",
  );
  assert.equal(
    formatCalendarDay(
      midQuarterDeemedServiceDate("2025-07-01", "2026-06-30", "2025-08-01"),
    ),
    "2025-08-15",
  );
});

test("half-year deemed date for a ten-month year starting in March is August 1", () => {
  assert.deepEqual(halfYearDeemedServiceDate("2023-03-15", "2023-12-31"), {
    year: 2023,
    month: 8,
    day: 1,
  });
  assert.equal(
    monthsTreatedInService({ year: 2023, month: 8, day: 1 }, "2023-12-31"),
    5,
  );
});

test("mid-quarter October 16 in a March 15–December 31 year deems September 1", () => {
  // 292 days, 73-day quarters. October 16 is in the August 8–October 19
  // quarter; midpoint September 13 snaps to the preceding 1st.
  assert.deepEqual(
    midQuarterDeemedServiceDate("2023-03-15", "2023-12-31", "2023-10-16"),
    { year: 2023, month: 9, day: 1 },
  );
  assert.equal(
    monthsTreatedInService({ year: 2023, month: 9, day: 1 }, "2023-12-31"),
    4,
  );
});

test("midpoint service retains the half month rather than charging a full month", () => {
  const half = halfYearDeemedServiceDate("2026-06-20", "2026-12-31");
  assert.equal(formatCalendarDay(half), "2026-09-15");
  assert.equal(monthsTreatedInService(half, "2026-12-31"), 3.5);
  assert.equal(
    shortYearPlacementDeduction({
      basis: "1000",
      rate: "0.4",
      monthsInService: 3.5,
    }),
    "116.67",
  );
  const quarter = midQuarterDeemedServiceDate(
    "2023-03-15",
    "2023-12-31",
    "2023-12-05",
  );
  assert.equal(formatCalendarDay(quarter), "2023-11-15");
  assert.equal(monthsTreatedInService(quarter, "2023-12-31"), 1.5);
  assert.equal(
    shortYearPlacementDeduction({
      basis: "1000",
      rate: "0.4",
      monthsInService: 1.5,
    }),
    "50.00",
  );
});

test("rate and factor precision is not rounded to ledger money precision", () => {
  assert.equal(decliningBalanceRate("200_db", "7"), "0.2857142857");
  assert.equal(
    impliedShortYearFactor("2026-03-15", "2026-12-31"),
    "0.8333333333",
  );
  assert.equal(
    assertShortYearFactorAgrees("2026-03-15", "2026-12-31", "0.8333333333"),
    "0.8333333333",
  );
  assert.throws(
    () => assertShortYearFactorAgrees("2026-03-15", "2026-12-31", "0.8333"),
    /does not match/,
  );
});

test("both recovery methods conserve basis across a half-month final recovery period", () => {
  const input = {
    method: "straight_line" as const,
    recoveryPeriodYears: "5",
    originalMacrsBasis: "1200",
    adjustedBasis: "10",
    elapsedMonths: 59.5,
    monthsThisYear: 12,
  };
  assert.equal(
    subsequentRecoveryDeduction({ ...input, shortYearMethod: "simplified" }),
    "10.00",
  );
  assert.equal(
    subsequentRecoveryDeduction({ ...input, shortYearMethod: "allocation" }),
    "10.00",
  );
});

test("a matching 6/12 factor agrees; a 0.5 factor on a 10-month year refuses", () => {
  assert.equal(
    cmp(impliedShortYearFactor("2023-01-01", "2023-06-30"), "0.5"),
    0,
  );
  assert.equal(
    cmp(assertShortYearFactorAgrees("2023-01-01", "2023-06-30", "0.5"), "0.5"),
    0,
  );
  assert.throws(
    () => assertShortYearFactorAgrees("2023-03-15", "2023-12-31", "0.5"),
    (error: unknown) =>
      error instanceof MacrsShortYearError &&
      /does not match/.test(error.message),
  );
});

test("a 0.49 or 0.52 factor does not round into agreement with a six-month year", () => {
  assert.throws(
    () => assertShortYearFactorAgrees("2023-01-01", "2023-06-30", "0.49"),
    (error: unknown) =>
      error instanceof MacrsShortYearError &&
      /does not match/.test(error.message),
  );
  assert.throws(
    () => assertShortYearFactorAgrees("2023-01-01", "2023-06-30", "0.52"),
    (error: unknown) =>
      error instanceof MacrsShortYearError &&
      /does not match/.test(error.message),
  );
});

test("5-year 200DB short-year placement is months/12 of the declining-balance amount", () => {
  const rate = decliningBalanceRate("200_db", "5");
  assert.equal(cmp(rate, "0.4"), 0);
  // IRS Pub 946 prints $167 and $133; two-decimal money keeps the exact twelfths.
  assert.equal(
    shortYearPlacementDeduction({ basis: "1000", rate, monthsInService: 5 }),
    "166.67",
  );
  assert.equal(
    shortYearPlacementDeduction({ basis: "1000", rate, monthsInService: 4 }),
    "133.33",
  );
  assert.equal(
    formatCalendarDay({ year: 2023, month: 8, day: 1 }),
    "2023-08-01",
  );
});
