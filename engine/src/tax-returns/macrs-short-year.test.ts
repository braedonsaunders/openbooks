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
  midQuarterDeemedServiceDate,
  monthsTreatedInService,
  shortTaxYearMonths,
  shortYearPlacementDeduction,
} from "./macrs-short-year.ts";

test("Pub 946 counts March 15–December 31 as ten months", () => {
  assert.equal(shortTaxYearMonths("2023-03-15", "2023-12-31"), 10);
  assert.equal(shortTaxYearMonths("2023-01-01", "2023-06-30"), 6);
});

test("half-year deemed date for a ten-month year starting in March is August 1", () => {
  assert.deepEqual(halfYearDeemedServiceDate("2023-03-15", "2023-12-31"), {
    year: 2023,
    month: 8,
    day: 1,
  });
  assert.equal(monthsTreatedInService({ year: 2023, month: 8, day: 1 }, "2023-12-31"), 5);
});

test("mid-quarter October 16 in a March 15–December 31 year deems September 1", () => {
  // 292 days, 73-day quarters. October 16 is in the August 8–October 19
  // quarter; midpoint September 13 snaps to the preceding 1st.
  assert.deepEqual(
    midQuarterDeemedServiceDate("2023-03-15", "2023-12-31", "2023-10-16"),
    { year: 2023, month: 9, day: 1 },
  );
  assert.equal(monthsTreatedInService({ year: 2023, month: 9, day: 1 }, "2023-12-31"), 4);
});

test("a matching 6/12 factor agrees; a 0.5 factor on a 10-month year refuses", () => {
  assert.equal(cmp(impliedShortYearFactor("2023-01-01", "2023-06-30"), "0.5"), 0);
  assert.equal(cmp(assertShortYearFactorAgrees("2023-01-01", "2023-06-30", "0.5"), "0.5"), 0);
  assert.throws(
    () => assertShortYearFactorAgrees("2023-03-15", "2023-12-31", "0.5"),
    (error: unknown) =>
      error instanceof MacrsShortYearError && /does not match/.test(error.message),
  );
});

test("5-year 200DB short-year placement is months/12 of the declining-balance amount", () => {
  const rate = decliningBalanceRate("200_db", "5");
  assert.equal(cmp(rate, "0.4"), 0);
  // IRS Pub 946 prints $167 and $133; two-decimal money keeps the exact twelfths.
  assert.equal(shortYearPlacementDeduction({ basis: "1000", rate, monthsInService: 5 }), "166.67");
  assert.equal(shortYearPlacementDeduction({ basis: "1000", rate, monthsInService: 4 }), "133.33");
  assert.equal(formatCalendarDay({ year: 2023, month: 8, day: 1 }), "2023-08-01");
});
