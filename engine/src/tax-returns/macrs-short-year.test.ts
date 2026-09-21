import assert from "node:assert/strict";
import test from "node:test";
import { add, cmp, formatMoney, neg } from "../money/money.ts";
import {
  MacrsShortYearError,
  addMacrsMonths,
  allocationRecoveryDeduction,
  assertShortYearFactorAgrees,
  compareMacrsMonths,
  decliningBalanceRate,
  formatCalendarDay,
  halfYearDeemedServiceDate,
  impliedShortYearFactor,
  isFullTaxYear,
  isShortTaxYear,
  macrsMonthRatio,
  macrsMonths,
  maxMacrsMonths,
  midQuarterDeemedServiceDate,
  monthsTreatedInService,
  monthsTreatedInServiceExact,
  remainingAfter,
  remainingAfterExact,
  shortTaxYearMonths,
  shortTaxYearMonthsExact,
  shortYearPlacementDeduction,
  subtractMacrsMonths,
  subsequentRecoveryDeduction,
  subsequentSimplifiedDeduction,
} from "./macrs-short-year.ts";

test("dating a conserved split checkpoint preserves sub-cent remaining basis", () => {
  const remaining = "416.6667";
  const taken = add("416.6667", "416.6666");
  assert.equal(remainingAfterExact(remaining, "0"), remaining);
  assert.equal(add(taken, remainingAfterExact(remaining, "0")), "1250.0000");
  assert.equal(remainingAfterExact(remaining, "100.00"), "316.6667");
  assert.equal(add(add(taken, "100.00"), remainingAfterExact(remaining, "100.00")), "1250.0000");
  const afterFirst = remainingAfterExact(remaining, "33.33");
  assert.equal(remainingAfterExact(afterFirst, "66.67"), remainingAfterExact(remaining, "100.00"));
  assert.equal(remainingAfterExact("0.0001", "0"), "0.0001");
  assert.equal(remainingAfterExact("0.0001", "0.0001"), "0.0000");
  // Preserve the pre-existing formatting boundary; it must not be reused as
  // the stored checkpoint whose conservation is proved above.
  assert.equal(remainingAfter(remaining, "0"), "416.67");
});

test("actual short-year months preserve both irregular boundaries and leap-month denominators", () => {
  assert.deepEqual(
    shortTaxYearMonthsExact("2023-01-10", "2023-02-20"),
    macrsMonthRatio(309n, 217n),
  );
  assert.deepEqual(
    shortTaxYearMonthsExact("2024-01-10", "2024-02-20"),
    macrsMonthRatio(1258n, 899n),
  );
  assert.deepEqual(
    shortTaxYearMonthsExact("2026-01-01", "2026-06-30"),
    macrsMonths(6),
  );
  assert.deepEqual(
    shortTaxYearMonthsExact("2025-07-01", "2026-06-30"),
    macrsMonths(12),
  );
  assert.deepEqual(
    shortTaxYearMonthsExact("2023-03-15", "2023-12-31"),
    macrsMonthRatio(296n, 31n),
  );
  // Ten touched months locate the HY convention date; they do not turn
  // March's actual tax-year boundary into March 1 for later-year recovery.
  assert.equal(shortTaxYearMonths("2023-03-15", "2023-12-31"), 10);
  assert.equal(
    formatCalendarDay(halfYearDeemedServiceDate("2023-03-15", "2023-12-31")),
    "2023-08-01",
  );
});

test("an actual month split conserves one month without counting both parts as whole months", () => {
  const first = shortTaxYearMonthsExact("2026-01-01", "2026-01-10");
  const second = shortTaxYearMonthsExact("2026-01-11", "2026-01-31");
  assert.deepEqual(first, macrsMonthRatio(10n, 31n));
  assert.deepEqual(second, macrsMonthRatio(21n, 31n));
  assert.deepEqual(addMacrsMonths(first, second), macrsMonths(1));
});

test("irregular factors use exact calendar fractions and cannot fall back to an average month", () => {
  assert.equal(
    impliedShortYearFactor("2023-01-10", "2023-02-20"),
    "0.1186635945",
  );
  assert.equal(
    assertShortYearFactorAgrees("2023-01-10", "2023-02-20", "0.1186635945"),
    "0.1186635945",
  );
  assert.throws(
    () =>
      assertShortYearFactorAgrees("2023-01-10", "2023-02-20", "0.0833333333"),
    /does not match/,
  );
  assert.throws(
    () => shortTaxYearMonths("2023-01-10", "2023-02-20"),
    /actual-day convention midpoint and exact recovery months/,
  );
});

test("deemed first and midpoint dates retain an actual partial year-end", () => {
  assert.deepEqual(
    monthsTreatedInServiceExact(
      { year: 2023, month: 1, day: 15 },
      "2023-02-20",
    ),
    macrsMonthRatio(17n, 14n),
  );
  assert.deepEqual(
    monthsTreatedInServiceExact({ year: 2023, month: 1, day: 1 }, "2023-01-10"),
    macrsMonthRatio(10n, 31n),
  );
  assert.deepEqual(
    monthsTreatedInServiceExact(
      { year: 2024, month: 2, day: 10 },
      "2024-03-20",
    ),
    macrsMonthRatio(1200n, 899n),
  );
  assert.deepEqual(
    monthsTreatedInServiceExact(
      { year: 2023, month: 11, day: 15 },
      "2023-12-31",
    ),
    macrsMonths(1.5),
  );
  assert.deepEqual(
    monthsTreatedInServiceExact(
      { year: 2023, month: 3, day: 15 },
      "2023-02-20",
    ),
    macrsMonths(0),
  );
  assert.equal(
    shortYearPlacementDeduction({
      basis: "8400",
      rate: "0.4",
      monthsInService: monthsTreatedInServiceExact(
        { year: 2023, month: 1, day: 15 },
        "2023-02-20",
      ),
    }),
    "340.00",
  );
});

test("exact recovery periods conserve the shared month independently of the HY midpoint exclusion", () => {
  const context = { excludedTerminalMonth: true };
  const first = shortTaxYearMonthsExact("2025-06-01", "2025-10-15", context);
  const second = shortTaxYearMonthsExact("2025-10-16", "2026-05-31");
  assert.deepEqual(first, macrsMonthRatio(139n, 31n));
  assert.deepEqual(second, macrsMonthRatio(233n, 31n));
  assert.deepEqual(addMacrsMonths(first, second), macrsMonths(12));
  assert.deepEqual(
    halfYearDeemedServiceDate("2025-06-01", "2025-10-15", context),
    { year: 2025, month: 8, day: 1 },
  );
  assert.deepEqual(
    monthsTreatedInServiceExact(
      { year: 2025, month: 8, day: 1 },
      "2025-10-15",
      context,
    ),
    macrsMonthRatio(77n, 31n),
  );
});

test("exact month helpers refuse invalid calendar facts and misplaced HY context", () => {
  const context = { excludedTerminalMonth: true };
  assert.throws(
    () => shortTaxYearMonthsExact("2023-02-29", "2023-03-31"),
    /calendar/,
  );
  assert.throws(
    () => shortTaxYearMonthsExact("2023-03-31", "2023-03-01"),
    /ends before/,
  );
  assert.throws(
    () => shortTaxYearMonthsExact("2023-01-01", "2024-01-31"),
    /exceeds twelve months/,
  );
  assert.throws(
    () => shortTaxYearMonthsExact("2023-01-10", "2023-02-20", context),
    /consecutive statutory windows/,
  );
  assert.throws(
    () =>
      monthsTreatedInServiceExact(
        { year: 2023, month: 2, day: 29 },
        "2023-03-31",
      ),
    /valid deemed date/,
  );
  assert.throws(
    () =>
      monthsTreatedInServiceExact(
        { year: 2023, month: 2, day: 15 },
        "2023-03-31",
        context,
      ),
    /cannot be shared/,
  );
});

test("exact month fractions conserve adjacent portions without binary or average-month rounding", () => {
  const oneDay = macrsMonthRatio(1n, 31n);
  const otherDays = macrsMonthRatio(30n, 31n);
  assert.deepEqual(addMacrsMonths(oneDay, otherDays), macrsMonths(1));
  assert.equal(compareMacrsMonths(macrsMonthRatio(2n, 62n), oneDay), 0);
  assert.equal(compareMacrsMonths(oneDay, macrsMonthRatio(1n, 30n)), -1);
  assert.deepEqual(macrsMonths(3.5), macrsMonthRatio(7n, 2n));
  assert.deepEqual(subtractMacrsMonths(1, otherDays), oneDay);
  assert.deepEqual(
    maxMacrsMonths(0, subtractMacrsMonths(oneDay, 1)),
    macrsMonths(0),
  );
  assert.throws(() => macrsMonthRatio(1n, 0n), /positive denominator/);
  assert.throws(() => macrsMonths(1 / 31), /exact numerator and denominator/);
  assert.throws(
    () => macrsMonths(Number.NaN),
    /exact numerator and denominator/,
  );
});

test("fractional service months multiply money without first rounding the duration", () => {
  assert.equal(
    shortYearPlacementDeduction({
      basis: "372000000000000.00",
      rate: "1",
      monthsInService: macrsMonthRatio(1n, 31n),
    }),
    "1000000000000.00",
  );
  assert.equal(
    subsequentSimplifiedDeduction({
      adjustedBasis: "3720.00",
      rate: "0.4",
      monthsInYear: macrsMonthRatio(1n, 31n),
    }),
    "4.00",
  );
  assert.throws(
    () =>
      shortYearPlacementDeduction({
        basis: "3720.00",
        rate: "0.4",
        monthsInService: macrsMonthRatio(-1n, 31n),
      }),
    /cannot be negative/,
  );
});

test("allocation crosses a recovery-year boundary at the exact fractional month", () => {
  // Last 1/31 month of recovery year one: 1488 / (31*12) = 4.
  // First 1/31 month of year two: 892.8 / (31*12) = 2.4.
  const args = {
    originalMacrsBasis: "3720.00",
    method: "200_db" as const,
    recoveryPeriodYears: "5",
    elapsedMonths: macrsMonthRatio(371n, 31n),
    monthsThisYear: macrsMonthRatio(2n, 31n),
  };
  assert.equal(allocationRecoveryDeduction(args), "6.40");
  assert.equal(
    subsequentRecoveryDeduction({
      ...args,
      adjustedBasis: "2500.00",
      shortYearMethod: "allocation",
    }),
    "6.40",
  );
});

test("both methods exhaust the final fractional recovery month without extending the schedule", () => {
  for (const shortYearMethod of ["simplified", "allocation"] as const) {
    assert.equal(
      subsequentRecoveryDeduction({
        method: "straight_line",
        recoveryPeriodYears: "5",
        originalMacrsBasis: "1200.00",
        adjustedBasis: "10.00",
        elapsedMonths: macrsMonthRatio(1859n, 31n),
        monthsThisYear: 12,
        shortYearMethod,
      }),
      "10.00",
      shortYearMethod,
    );
    assert.equal(
      subsequentRecoveryDeduction({
        method: "straight_line",
        recoveryPeriodYears: "5",
        originalMacrsBasis: "1200.00",
        adjustedBasis: "0.00",
        elapsedMonths: macrsMonths(60),
        monthsThisYear: 12,
        shortYearMethod,
      }),
      "0.00",
      shortYearMethod,
    );
  }
});

test("Pub 946 counts March 15–December 31 as ten months", () => {
  assert.equal(shortTaxYearMonths("2023-03-15", "2023-12-31"), 10);
  assert.equal(shortTaxYearMonths("2023-01-01", "2023-06-30"), 6);
});

test("Rev. Proc. 89-15 consecutive short years allocate their shared October only once", () => {
  // §4.01(1)(a)(i)'s original worked example. The caller derives context
  // from Jun1–Oct15 followed immediately by Oct16–May31, not from a UI flag.
  const context = { excludedTerminalMonth: true };
  assert.equal(shortTaxYearMonths("2025-06-01", "2025-10-15", context), 4);
  assert.equal(shortTaxYearMonths("2025-10-16", "2026-05-31"), 8);
  const first = halfYearDeemedServiceDate("2025-06-01", "2025-10-15", context);
  const second = halfYearDeemedServiceDate("2025-10-16", "2026-05-31");
  assert.equal(formatCalendarDay(first), "2025-08-01");
  assert.equal(formatCalendarDay(second), "2026-02-01");
  assert.deepEqual(
    monthsTreatedInServiceExact(first, "2025-10-15", context),
    macrsMonthRatio(77n, 31n),
  );
  assert.throws(
    () => monthsTreatedInService(first, "2025-10-15", context),
    /requires exact month fractions/,
  );
  assert.equal(monthsTreatedInService(second, "2026-05-31"), 4);
  assert.equal(
    impliedShortYearFactor("2025-06-01", "2025-10-15", context),
    "0.3736559140",
  );
  assert.throws(
    () =>
      assertShortYearFactorAgrees(
        "2025-06-01",
        "2025-10-15",
        "0.4166666667",
        context,
      ),
    /does not match/,
  );
  assert.throws(
    () => shortTaxYearMonths("2025-06-01", "2025-10-31", context),
    /consecutive statutory windows/,
  );
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

test("Rev. Proc. 89-15 table 2 gives December 16 the third quarter of a one-month year", () => {
  // Test both sides of every published boundary, not only quarter interiors.
  for (const [placed, deemed] of [
    ["1988-12-01", "1988-12-01"],
    ["1988-12-08", "1988-12-01"],
    ["1988-12-09", "1988-12-01"],
    ["1988-12-15", "1988-12-01"],
    ["1988-12-16", "1988-12-15"],
    ["1988-12-23", "1988-12-15"],
    ["1988-12-24", "1988-12-15"],
    ["1988-12-31", "1988-12-15"],
  ]) {
    assert.equal(
      formatCalendarDay(
        midQuarterDeemedServiceDate("1988-12-01", "1988-12-31", placed!),
      ),
      deemed,
      placed,
    );
  }
});

test("Rev. Proc. 89-15 table 1 preserves all 73-day quarter boundaries", () => {
  for (const [placed, deemed] of [
    ["1988-03-15", "1988-04-15"],
    ["1988-05-26", "1988-04-15"],
    ["1988-05-27", "1988-07-01"],
    ["1988-08-07", "1988-07-01"],
    ["1988-08-08", "1988-09-01"],
    ["1988-10-19", "1988-09-01"],
    ["1988-10-20", "1988-11-15"],
    ["1988-12-31", "1988-11-15"],
  ]) {
    assert.equal(
      formatCalendarDay(
        midQuarterDeemedServiceDate("1988-03-15", "1988-12-31", placed!),
      ),
      deemed,
      placed,
    );
  }
});

test("rate and factor precision is not rounded to ledger money precision", () => {
  assert.equal(decliningBalanceRate("200_db", "7"), "0.2857142857");
  assert.equal(
    impliedShortYearFactor("2026-03-15", "2026-12-31"),
    "0.7956989247",
  );
  assert.equal(
    assertShortYearFactorAgrees("2026-03-15", "2026-12-31", "0.7956989247"),
    "0.7956989247",
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

test("Rev. Proc. 89-15 tables 3 and 4 switch in the taxable year, preserving every year's allowance", () => {
  // Original primary source, printed pp. 820–822:
  // https://www.govinfo.gov/content/pkg/GOVPUB-T22-aaf296b1f844da19743e7a36ca791ec6/pdf/GOVPUB-T22-aaf296b1f844da19743e7a36ca791ec6-1.pdf
  // $100, 5-year 200DB, deemed placed August 1, 1988. Table 3's
  // recovery-year DB allocations are compared to TAX-year opening-basis SL.
  for (const shortYearMethod of ["allocation", "simplified"] as const) {
    const allowances = [
      shortYearPlacementDeduction({
        basis: "100",
        rate: "0.4",
        monthsInService: 5,
      }),
    ];
    let adjustedBasis = formatMoney(add("100", neg(allowances[0]!)), 2);
    for (const elapsedMonths of [5, 17, 29, 41, 53]) {
      const allowance = subsequentRecoveryDeduction({
        originalMacrsBasis: "100",
        adjustedBasis,
        method: "200_db",
        recoveryPeriodYears: "5",
        elapsedMonths,
        monthsThisYear: 12,
        shortYearMethod,
      });
      allowances.push(allowance);
      adjustedBasis = formatMoney(add(adjustedBasis, neg(allowance)), 2);
    }
    assert.deepEqual(
      allowances,
      ["16.67", "33.33", "20.00", "12.00", "11.37", "6.63"],
      shortYearMethod,
    );
    assert.equal(adjustedBasis, "0.00", shortYearMethod);
  }
});

test("Rev. Proc. 89-15 subsequent short year preserves the allocation/simplified distinction", () => {
  // §5.03 example (2) / §5.04 example (2): $100 placed in the May–Dec
  // short year is deemed placed September 1. The next year is Jan–Jun.
  const input = {
    originalMacrsBasis: "100",
    adjustedBasis: "86.67",
    method: "200_db" as const,
    recoveryPeriodYears: "5",
    elapsedMonths: 4,
    monthsThisYear: 6,
  };
  assert.equal(
    subsequentRecoveryDeduction({ ...input, shortYearMethod: "allocation" }),
    "20.00",
  );
  // This follows the published worked amount, including rounding the annual
  // allowance to cents before allocating the half year.
  assert.equal(
    subsequentRecoveryDeduction({ ...input, shortYearMethod: "simplified" }),
    "17.34",
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
