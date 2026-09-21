import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMacrsWindowsCover,
  computePoolYear,
  computeMacrsYear,
  computeMacrsThroughYear,
  exclusiveShortYearMonths,
  adjacentShortYearExclusion,
  fiscalMacrsYearWindow,
  macrsLineageRecoveryWindows,
  macrsOwnershipWindowLoads,
  macrsWindowsPreservingAppliedContext,
  lastThreeMonthsStart,
  macrsWindowsThroughFiscalCalendar,
  parsePersistedMacrsMonths,
  persistMacrsMonths,
  refreshOpenMacrsVintageThrough,
  macrsConventionAfterMidQuarter,
  macrsMidQuarterApplies,
  macrsMidQuarterByWindow,
  macrsWindowIdentity,
  eligibleMacrsMidQuarterPlacements,
  shortYearMathEnd,
  placedAndDisposedInSameTaxYear,
  section168i7HeldMonths,
  resolvePoolClass,
  TAX_DEPRECIATION_REGIMES,
  type PoolYearInput,
} from "./depreciation-pool.ts";
import {
  addMacrsMonths,
  impliedShortYearFactor,
  macrsMonthRatio,
  macrsMonths,
  remainingAfter,
  shortTaxYearMonthsExact,
  subsequentRecoveryDeduction,
} from "./macrs-short-year.ts";
import { add, cmp, formatMoney, mulRatio, neg, sum } from "../money/money.ts";

const run = (over: Partial<PoolYearInput>): ReturnType<typeof computePoolYear> =>
  computePoolYear({ openingBalance: "0", additions: "0", dispositions: "0", rate: 0.2, ...over });

test("ships multiple pooled regimes (not just Canada), all resolvable", () => {
  assert.deepEqual(
    Object.keys(TAX_DEPRECIATION_REGIMES).sort(),
    ["au_pool", "ca_cca", "nz_pool", "uk_wda", "us_macrs"],
  );
  // UK main pool 18% full-year; AU small-business pool 30% at half in year one.
  assert.equal(resolvePoolClass("uk_wda", "main")?.rate, 0.18);
  assert.equal(resolvePoolClass("uk_wda", "main")?.firstYearFraction, 1);
  assert.equal(resolvePoolClass("au_pool", "sbp")?.firstYearFraction, 0.5);
  assert.equal(resolvePoolClass("ca_cca", "10")?.firstYearFraction, 0.5); // half-year rule
});

test("U.S. MACRS 5-year 200% DB half-year schedule switches to straight line", () => {
  const amounts = [2025, 2026, 2027, 2028, 2029, 2030].map((taxYear) =>
    computeMacrsYear({
      basis: "10000", placedInServiceOn: "2025-08-11", taxYear,
      recoveryPeriodYears: 5, method: "200_db", convention: "half_year",
    }).allowance,
  );
  assert.deepEqual(amounts, ["2000.00", "3200.00", "1920.00", "1152.00", "1152.00", "576.00"]);
});

test("U.S. MACRS supports mid-quarter and mid-month conventions", () => {
  assert.equal(computeMacrsYear({
    basis: "10000", placedInServiceOn: "2025-11-15", taxYear: 2025,
    recoveryPeriodYears: 5, method: "200_db", convention: "mid_quarter",
  }).allowance, "500.00");
  assert.equal(computeMacrsYear({
    basis: "10000", placedInServiceOn: "2025-01-10", taxYear: 2025,
    recoveryPeriodYears: 27.5, method: "straight_line", convention: "mid_month",
  }).allowance, "348.48");
});

test("U.S. MACRS applies configured section 179, bonus, and business-use elections", () => {
  const result = computeMacrsYear({
    basis: "10000", placedInServiceOn: "2025-04-01", taxYear: 2025,
    recoveryPeriodYears: 5, method: "200_db", convention: "half_year",
    businessUsePercent: 80, section179: "1000", bonusPercent: 40,
  });
  assert.equal(result.section179, "1000.00");
  assert.equal(result.bonus, "2800.00");
  assert.equal(result.macrs, "840.00");
  assert.equal(result.allowance, "4640.00");
  assert.equal(result.remainingBasis, "3360.00");
});

test("U.S. MACRS remains exact above Number.MAX_SAFE_INTEGER with fractional elections", () => {
  const result = computeMacrsYear({
    basis: "9007199254740993.1234", placedInServiceOn: "2025-04-01", taxYear: 2025,
    recoveryPeriodYears: "5", method: "200_db", convention: "half_year",
    businessUsePercent: "33.3333", section179: "0.0001", bonusPercent: "12.3456",
  });
  assert.deepEqual(result, {
    section179: "0.00",
    bonus: "370663893066837.62",
    macrs: "526346571222748.37",
    allowance: "897010464289585.99",
    remainingBasis: "2105386284890993.47",
  });
});

// The Canada CCA half-year rule is just firstYearFraction 0.5 on a generic pool.
test("first-year fraction (Canada half-year rule) halves year-1 additions", () => {
  const r = run({ additions: "10000", firstYearFraction: 0.5 });
  assert.equal(r.base, "5000.00");
  assert.equal(r.allowance, "1000.00");
  assert.equal(r.closingBalance, "9000.00");
});

test("year 2 depreciates the full opening balance", () => {
  const r = run({ openingBalance: "9000" });
  assert.equal(r.allowance, "1800.00");
  assert.equal(r.closingBalance, "7200.00");
});

test("enhanced first-year multiplier (Canada AII) suspends the fraction and boosts the base", () => {
  const r = run({ additions: "10000", firstYearFraction: 0.5, enhancedFirstYearMultiplier: 1.5 });
  assert.equal(r.base, "15000.00");
  assert.equal(r.allowance, "3000.00");
});

test("full first-year fraction (exempt class) takes the full rate immediately", () => {
  const r = run({ additions: "5000", rate: 1.0, firstYearFraction: 1 });
  assert.equal(r.allowance, "5000.00");
  assert.equal(r.closingBalance, "0.00");
});

test("recapture / balancing charge when disposals exceed the pool", () => {
  const r = run({ openingBalance: "2000", dispositions: "5000" });
  assert.equal(r.recapture, "3000.00");
  assert.equal(r.closingBalance, "0.00");
});

test("terminal loss when the pool empties with value left", () => {
  const r = run({ openingBalance: "3000", poolHasAssetsAtYearEnd: false });
  assert.equal(r.terminalLoss, "3000.00");
});

test("short fiscal year prorates the allowance", () => {
  const r = run({ openingBalance: "10000", rate: 0.3, shortYearFactor: 0.5 });
  assert.equal(r.allowance, "1500.00");
});

test("discretionary claim cap limits the allowance and preserves the balance", () => {
  const r = run({ openingBalance: "10000", claimCap: "500" });
  assert.equal(r.allowance, "500.00");
  assert.equal(r.closingBalance, "9500.00");
});

test("out-of-domain scaling knobs fail closed instead of misstating the allowance", () => {
  const base = { openingBalance: "10000", rate: 0.2 };
  // A short-year factor above 1 used to double the allowance ($4000 for $2000
  // of statutory depreciation); zero/negative silently claimed nothing.
  assert.throws(() => run({ ...base, shortYearFactor: 2 }), /short year factor/);
  assert.throws(() => run({ ...base, shortYearFactor: 0 }), /short year factor/);
  assert.throws(() => run({ ...base, shortYearFactor: -0.5 }), /short year factor/);
  // A first-year fraction above 1 deducted more than the rate allows
  // ($6000 on a $20000 base at 20%); a negative one inflated the base.
  assert.throws(
    () => run({ ...base, additions: "10000", firstYearFraction: 2 }),
    /first year fraction/,
  );
  assert.throws(() => run({ ...base, firstYearFraction: -0.5 }), /first year fraction/);
  // A negative rate silently zeroed the allowance instead of refusing.
  assert.throws(() => run({ ...base, rate: -0.05 }), /rate cannot be negative/);
  // A negative claim cap silently disallowed the whole claim.
  assert.throws(() => run({ ...base, claimCap: "-1" }), /claim cap cannot be negative/);
  // The cap is validated ahead of the early returns: a negative cap on the
  // recapture branch used to return recapture without ever refusing the cap.
  assert.throws(
    () => run({ openingBalance: "2000", dispositions: "5000", claimCap: "-1" }),
    /claim cap cannot be negative/,
  );
  // Boundary values stay legal: full year, half-year rule, zero rate, zero cap.
  assert.equal(run({ ...base, shortYearFactor: 1 }).allowance, "2000.00");
  assert.equal(run({ ...base, shortYearFactor: 0.5 }).allowance, "1000.00");
  assert.equal(run({ ...base, firstYearFraction: 0 }).allowance, "2000.00");
  assert.equal(run({ ...base, rate: 0 }).allowance, "0.00");
  assert.equal(run({ ...base, claimCap: "0" }).allowance, "0.00");
});

test("U.S. MACRS bonus and business-use percents fail closed outside 0..100", () => {
  const base = {
    basis: "10000", placedInServiceOn: "2025-04-01", taxYear: 2025,
    recoveryPeriodYears: 5 as const, method: "200_db" as const, convention: "half_year" as const,
  };
  // A 200% bonus used to deduct twice the basis ($20,000 on $10,000).
  assert.throws(() => computeMacrsYear({ ...base, bonusPercent: 200 }), /bonus percent/);
  assert.throws(() => computeMacrsYear({ ...base, bonusPercent: -10 }), /bonus percent/);
  assert.throws(() => computeMacrsYear({ ...base, businessUsePercent: 150 }), /business use percent/);
  assert.throws(() => computeMacrsYear({ ...base, businessUsePercent: -5 }), /business use percent/);
  // Elections are validated ahead of the date early-returns: a 200% bonus on
  // a pre-placement year used to return zero without refusing the election.
  assert.throws(() => computeMacrsYear({ ...base, taxYear: 2024, bonusPercent: 200 }), /bonus percent/);
  // Boundaries stay legal: full bonus deducts the whole basis, zero business
  // use deducts nothing.
  assert.equal(computeMacrsYear({ ...base, bonusPercent: 100 }).allowance, "10000.00");
  assert.equal(computeMacrsYear({ ...base, businessUsePercent: 0 }).allowance, "0.00");
});

test("U.S. MACRS short year uses Pub 946 deemed dates, not a scaled calendar schedule", () => {
  const tara = {
    basis: "1000",
    placedInServiceOn: "2023-10-16",
    taxYear: 2023,
    recoveryPeriodYears: 5 as const,
    method: "200_db" as const,
    convention: "half_year" as const,
    yearStart: "2023-03-15",
    yearEnd: "2023-12-31",
  };
  // §4.01 still counts ten touched months to place the HY midpoint on Aug 1.
  // §4.02 recovery is the actual Mar 15–Dec 31 period (74/93), then five
  // service months after that midpoint. IRS rounds the printed example to $167.
  const half = computeMacrsYear(tara);
  assert.equal(half.allowance, "166.67");
  assert.equal(half.remainingBasis, "833.33");
  assert.equal(impliedShortYearFactor(tara.yearStart, tara.yearEnd), "0.7956989247");
  assert.equal(
    computeMacrsYear({ ...tara, shortYearFactor: "0.7956989247" }).allowance,
    "166.67",
  );
  assert.throws(
    () => computeMacrsYear({ ...tara, shortYearFactor: "0.8333333333" }),
    /does not match/,
  );
  // Mid-quarter Oct 16 sits in the Aug 8–Oct 19 quarter; midpoint Sep 13 snaps
  // to Sep 1, so 4/12 × $400. IRS prints $133.
  const midQuarter = computeMacrsYear({ ...tara, convention: "mid_quarter" });
  assert.equal(midQuarter.allowance, "133.33");
  const simplified = computeMacrsYear({
    ...tara,
    taxYear: 2024,
    yearStart: "2024-01-01",
    yearEnd: "2024-12-31",
    afterShortYear: true,
    adjustedBasisAtYearStart: half.remainingBasis,
  });
  assert.equal(simplified.allowance, "333.33");
  const allocated = computeMacrsYear({
    ...tara,
    taxYear: 2024,
    yearStart: "2024-01-01",
    yearEnd: "2024-12-31",
    afterShortYear: true,
    shortYearMethod: "allocation",
    allocationFollowYear: true,
    firstYearMonthsInService: 5,
    deemedPlacedOn: "2023-08-01",
  });
  // 7/12 × $400 + 5/12 × $240 uses original MACRS basis, not the $833 opening.
  assert.equal(allocated.allowance, "333.33");
  assert.throws(
    () => computeMacrsYear({ ...tara, yearStart: undefined, yearEnd: undefined, shortYearFactor: "0.5" }),
    /yearStart and yearEnd/,
  );
  assert.throws(
    () => computeMacrsYear({ ...tara, shortYearFactor: "0.5" }),
    /does not match/,
  );
  const walked = computeMacrsThroughYear({
    ...tara,
    taxYear: 2024,
    yearStart: "2024-01-01",
    yearEnd: "2024-12-31",
  }, [
    { taxYear: 2023, yearStart: "2023-03-15", yearEnd: "2023-12-31" },
    { taxYear: 2024, yearStart: "2024-01-01", yearEnd: "2024-12-31" },
  ]);
  assert.equal(walked.current.allowance, "333.33");
  assert.equal(walked.prior.allowance, "166.67");
  assert.equal(walked.deemedPlacedOn, "2023-08-01");
  assert.deepEqual(walked.firstYearMonthsInService, persistMacrsMonths(5));
  assert.equal(walked.allocationFollowYear, true);
});

test("Pub 946 excepted property: taxable same-tax-year place and dispose takes no MACRS service", () => {
  const placedSold = {
    basis: "10000",
    placedInServiceOn: "2025-03-01",
    taxYear: 2025,
    recoveryPeriodYears: 5 as const,
    method: "200_db" as const,
    convention: "half_year" as const,
    disposedOn: "2025-09-15",
  };
  assert.equal(computeMacrsYear(placedSold).allowance, "0.00");
  assert.equal(computeMacrsYear(placedSold).remainingBasis, "0.00");
  // A nontaxable step-in-shoes transfer in the same year keeps convention continuity.
  assert.equal(
    computeMacrsYear({ ...placedSold, dispositionRecognition: "nontaxable" }).allowance,
    "2000.00",
  );
});

test("same-tax-year excepted property uses the fiscal window, not equal YYYY", () => {
  assert.equal(
    placedAndDisposedInSameTaxYear({
      placedInServiceOn: "2025-10-01",
      disposedOn: "2026-03-01",
      yearStart: "2025-07-01",
      yearEnd: "2026-06-30",
      taxYear: 2025,
    }),
    true,
  );
  assert.equal(
    placedAndDisposedInSameTaxYear({
      placedInServiceOn: "2025-03-01",
      disposedOn: "2026-03-01",
      yearStart: "2025-01-01",
      yearEnd: "2025-12-31",
      taxYear: 2025,
    }),
    false,
  );
  const fiscal = computeMacrsYear({
    basis: "10000",
    placedInServiceOn: "2025-10-01",
    disposedOn: "2026-03-01",
    taxYear: 2025,
    yearStart: "2025-07-01",
    yearEnd: "2026-06-30",
    recoveryPeriodYears: 5,
    method: "200_db",
    convention: "half_year",
  });
  assert.equal(fiscal.allowance, "0.00");
});

test("a placement after the tax-year window takes no deemed first-year service", () => {
  const future = computeMacrsYear({
    basis: "10000",
    placedInServiceOn: "2026-10-01",
    taxYear: 2026,
    yearStart: "2026-01-01",
    yearEnd: "2026-06-30",
    recoveryPeriodYears: 5,
    method: "200_db",
    convention: "half_year",
    shortYearFactor: "0.5",
  });
  assert.equal(future.allowance, "0.00");
  assert.equal(future.remainingBasis, "10000.00");
});

test("a full July–June fiscal year is recovery year 1 for an August placement, not calendar year 2", () => {
  const first = computeMacrsThroughYear({
    basis: "10000",
    placedInServiceOn: "2025-08-11",
    taxYear: 2026,
    recoveryPeriodYears: 5,
    method: "200_db",
    convention: "half_year",
  }, [
    { taxYear: 2026, yearStart: "2025-07-01", yearEnd: "2026-06-30" },
  ]);
  assert.equal(first.current.allowance, "2000.00");
  const second = computeMacrsThroughYear({
    basis: "10000",
    placedInServiceOn: "2025-08-11",
    taxYear: 2027,
    recoveryPeriodYears: 5,
    method: "200_db",
    convention: "half_year",
  }, [
    { taxYear: 2026, yearStart: "2025-07-01", yearEnd: "2026-06-30" },
    { taxYear: 2027, yearStart: "2026-07-01", yearEnd: "2027-06-30" },
  ]);
  assert.equal(second.current.allowance, "3200.00");
  assert.equal(second.prior.allowance, "2000.00");
});

test("the first short year after full service years continues walked remaining, not a new first-year asset", () => {
  const walked = computeMacrsThroughYear({
    basis: "10000",
    placedInServiceOn: "2023-03-15",
    taxYear: 2025,
    recoveryPeriodYears: 5,
    method: "200_db",
    convention: "half_year",
  }, [
    { taxYear: 2023, yearStart: "2023-01-01", yearEnd: "2023-12-31" },
    { taxYear: 2024, yearStart: "2024-01-01", yearEnd: "2024-12-31" },
    { taxYear: 2025, yearStart: "2025-01-01", yearEnd: "2025-06-30" },
  ]);
  // Full years: 2000 then 3200, remaining 4800. Six-month subsequent DB is 960,
  // not 2000 (new first-year 6/12 of original) or 1920 (full year 3).
  assert.equal(walked.prior.allowance, "3200.00");
  assert.equal(walked.current.allowance, "960.00");
  assert.equal(walked.current.section179, "0.00");
});

test("a short year before this vintage existed does not skip its first-year convention or section 179", () => {
  const walked = computeMacrsThroughYear({
    basis: "10000",
    placedInServiceOn: "2024-08-11",
    taxYear: 2024,
    recoveryPeriodYears: 5,
    method: "200_db",
    convention: "half_year",
    section179: "1000",
  }, [
    { taxYear: 2022, yearStart: "2022-01-01", yearEnd: "2022-06-30" },
    { taxYear: 2023, yearStart: "2023-01-01", yearEnd: "2023-12-31" },
    { taxYear: 2024, yearStart: "2024-01-01", yearEnd: "2024-12-31" },
  ]);
  assert.equal(walked.current.section179, "1000.00");
  assert.equal(walked.current.macrs, "1800.00");
  assert.equal(walked.current.allowance, "2800.00");
});

test("a later year after disposal records zero remaining, not the original basis", () => {
  const windows = [
    { taxYear: 2024, yearStart: "2024-01-01", yearEnd: "2024-12-31" },
    { taxYear: 2025, yearStart: "2025-01-01", yearEnd: "2025-12-31" },
    { taxYear: 2026, yearStart: "2026-01-01", yearEnd: "2026-12-31" },
  ];
  const after = computeMacrsThroughYear({
    basis: "10000",
    placedInServiceOn: "2024-03-01",
    taxYear: 2026,
    recoveryPeriodYears: 5,
    method: "200_db",
    convention: "half_year",
    disposedOn: "2025-09-15",
    dispositionRecognition: "taxable",
  }, windows);
  assert.equal(after.current.allowance, "0.00");
  assert.equal(after.current.remainingBasis, "0.00");
  assert.notEqual(after.current.remainingBasis, "10000.00");
});

test("later fiscal windows keep the original placement month, not month 1 of the current year", () => {
  const windows = [
    { taxYear: 2026, yearStart: "2025-07-01", yearEnd: "2026-06-30" },
    { taxYear: 2027, yearStart: "2026-07-01", yearEnd: "2027-06-30" },
  ];
  const walked = computeMacrsThroughYear({
    basis: "10000",
    placedInServiceOn: "2025-11-15",
    taxYear: 2027,
    recoveryPeriodYears: 5,
    method: "200_db",
    convention: "mid_quarter",
  }, windows);
  const year1 = computeMacrsYear({
    basis: "10000",
    placedInServiceOn: "2025-11-15",
    taxYear: 2026,
    yearStart: "2025-07-01",
    yearEnd: "2026-06-30",
    recoveryPeriodYears: 5,
    method: "200_db",
    convention: "mid_quarter",
    recoveryYearIndex: 0,
    placedMonth: 5,
  });
  const year2 = computeMacrsYear({
    basis: "10000",
    placedInServiceOn: "2025-11-15",
    taxYear: 2027,
    yearStart: "2026-07-01",
    yearEnd: "2027-06-30",
    recoveryPeriodYears: 5,
    method: "200_db",
    convention: "mid_quarter",
    recoveryYearIndex: 1,
    placedMonth: 5,
  });
  const januaryOrigin = computeMacrsYear({
    basis: "10000",
    placedInServiceOn: "2025-11-15",
    taxYear: 2027,
    yearStart: "2026-07-01",
    yearEnd: "2027-06-30",
    recoveryPeriodYears: 5,
    method: "200_db",
    convention: "mid_quarter",
    recoveryYearIndex: 1,
    placedMonth: 1,
  });
  assert.equal(walked.prior.allowance, year1.allowance);
  assert.equal(walked.current.allowance, year2.allowance);
  assert.notEqual(walked.current.allowance, januaryOrigin.allowance);
});

test("declared adjusted carryover is the buyer checkpoint; pre-transfer years do not re-subtract from it", () => {
  const walked = computeMacrsThroughYear({
    basis: "10000",
    placedInServiceOn: "2023-01-01",
    taxYear: 2025,
    recoveryPeriodYears: 5,
    method: "200_db",
    convention: "half_year",
    adjustedCarryover: "6400.00",
    carryoverOn: "2025-01-01",
  }, [
    { taxYear: 2023, yearStart: "2023-01-01", yearEnd: "2023-12-31" },
    { taxYear: 2024, yearStart: "2024-01-01", yearEnd: "2024-12-31" },
    { taxYear: 2025, yearStart: "2025-01-01", yearEnd: "2025-12-31" },
  ]);
  // Year 3 of original 10000 is 1920. Checkpoint 6400 is not the walked 4800.
  assert.equal(walked.prior.remainingBasis, "6400.0000");
  assert.equal(walked.current.allowance, "1920.00");
  assert.equal(walked.current.remainingBasis, "4480.00");
});

test("transfer-year buyer residual is stored in the walk so next year's opening matches the persisted close", () => {
  const windows = [
    { taxYear: 2023, yearStart: "2023-01-01", yearEnd: "2023-12-31" },
    { taxYear: 2024, yearStart: "2024-01-01", yearEnd: "2024-12-31" },
    { taxYear: 2025, yearStart: "2025-01-01", yearEnd: "2025-12-31" },
    { taxYear: 2026, yearStart: "2026-01-01", yearEnd: "2026-12-31" },
  ];
  const input = {
    basis: "10000",
    placedInServiceOn: "2023-01-01",
    recoveryPeriodYears: 5 as const,
    method: "200_db" as const,
    convention: "half_year" as const,
    adjustedCarryover: "6400.00",
    carryoverOn: "2025-07-01",
  };
  const transferYear = computeMacrsThroughYear({ ...input, taxYear: 2025 }, windows);
  const nextYear = computeMacrsThroughYear({ ...input, taxYear: 2026 }, windows);
  // Year 3 full table amount is 1920; mid-year HY seller share is 960; buyer residual 960.
  // Checkpoint 6400 − 960 = 5440. Subtracting the full 1920 would leave 4480.
  assert.equal(transferYear.current.allowance, "960.00");
  assert.equal(transferYear.current.remainingBasis, "5440.00");
  assert.equal(nextYear.prior.remainingBasis, transferYear.current.remainingBasis);
  assert.equal(nextYear.prior.allowance, transferYear.current.allowance);
  assert.notEqual(nextYear.prior.remainingBasis, "4480.00");
});

test("successive short years keep actual shared-month days in the deduction numerators", () => {
  const windows = [
    { taxYear: 1988, yearStart: "1988-06-01", yearEnd: "1988-10-15" },
    { taxYear: 1989, yearStart: "1988-10-16", yearEnd: "1989-05-31" },
  ];
  const firstMonths = exclusiveShortYearMonths(windows, 0);
  const secondMonths = exclusiveShortYearMonths(windows, 1);
  assert.deepEqual(firstMonths, macrsMonthRatio(139n, 31n));
  assert.deepEqual(secondMonths, macrsMonthRatio(233n, 31n));
  assert.deepEqual(addMacrsMonths(firstMonths, secondMonths), macrsMonths(12));
  assert.equal(impliedShortYearFactor("1988-06-01", "1988-10-15"), "0.3736559140");
  assert.notEqual(
    addMacrsMonths(shortTaxYearMonthsExact("1988-06-01", "1988-09-30"), secondMonths),
    macrsMonths(12),
    "clipping the first year-end to September 30 loses October's 15/31",
  );
  assert.equal(shortYearMathEnd("1988-10-15", true), "1988-09-30");
  const first = computeMacrsThroughYear({
    basis: "100",
    placedInServiceOn: "1988-06-01",
    taxYear: 1988,
    recoveryPeriodYears: 5,
    method: "200_db",
    convention: "half_year",
  }, windows);
  assert.equal(first.deemedPlacedOn, "1988-08-01");
  assert.deepEqual(first.firstYearMonthsInService, persistMacrsMonths(macrsMonthRatio(77n, 31n)));
  assert.notDeepEqual(first.firstYearMonthsInService, persistMacrsMonths(2));
  assert.equal(first.current.allowance, "8.28");
  const persisted = JSON.parse(JSON.stringify(first.firstYearMonthsInService));
  assert.deepEqual(persisted, { numerator: "77", denominator: "31" });
  assert.deepEqual(parsePersistedMacrsMonths(persisted), macrsMonthRatio(77n, 31n));
  assert.throws(
    () => JSON.stringify(macrsMonthRatio(77n, 31n)),
    /BigInt/,
  );
});

test("fiscal calendar windows are first-and-last day bounds, including July–June", () => {
  assert.deepEqual(fiscalMacrsYearWindow(2026, 1), {
    taxYear: 2026,
    yearStart: "2026-01-01",
    yearEnd: "2026-12-31",
  });
  assert.deepEqual(fiscalMacrsYearWindow(2026, 7), {
    taxYear: 2026,
    yearStart: "2025-07-01",
    yearEnd: "2026-06-30",
  });
  assert.deepEqual(
    macrsWindowsThroughFiscalCalendar({
      yearStartMonth: 1,
      fromOn: "2023-03-15",
      throughOn: "2026-09-01",
    }).map((row) => row.taxYear),
    [2023, 2024, 2025, 2026],
  );
});

test("two short years ending in the same calendar year both survive and prior is the earlier window", () => {
  const first = { taxYear: 2024, yearStart: "2024-01-01", yearEnd: "2024-03-31" };
  const second = { taxYear: 2024, yearStart: "2024-04-01", yearEnd: "2024-12-31" };
  const covered = assertMacrsWindowsCover([second, first], "2024-01-15", "2024-08-20");
  assert.deepEqual(
    covered.map((window) => `${window.yearStart}:${window.yearEnd}`),
    ["2024-01-01:2024-03-31", "2024-04-01:2024-12-31"],
  );
  const walked = computeMacrsThroughYear({
    basis: "10000",
    placedInServiceOn: "2024-01-15",
    taxYear: 2024,
    yearStart: "2024-04-01",
    yearEnd: "2024-12-31",
    recoveryPeriodYears: 5,
    method: "200_db",
    convention: "half_year",
  }, [first, second]);
  assert.notEqual(walked.prior.allowance, "0.00");
  assert.notEqual(walked.current.allowance, walked.prior.allowance);
  assert.throws(
    () => computeMacrsThroughYear({
      basis: "10000",
      placedInServiceOn: "2024-01-15",
      taxYear: 2024,
      recoveryPeriodYears: 5,
      method: "200_db",
      convention: "half_year",
    }, [first, second]),
    /names 2 windows/,
  );
});

test("cover keeps one convention successor and the walk stops at the requested bound", () => {
  const first = { taxYear: 2024, yearStart: "2024-01-01", yearEnd: "2024-03-15" };
  const successor = { taxYear: 2024, yearStart: "2024-03-16", yearEnd: "2024-12-31" };
  const covered = assertMacrsWindowsCover([first, successor], "2024-01-15", "2024-03-10");
  assert.deepEqual(
    covered.map((window) => `${window.yearStart}:${window.yearEnd}`),
    ["2024-01-01:2024-03-15", "2024-03-16:2024-12-31"],
  );
  assert.equal(adjacentShortYearExclusion(covered, 0), true);
  const walked = computeMacrsThroughYear({
    basis: "10000",
    placedInServiceOn: "2024-01-15",
    taxYear: 2024,
    yearStart: "2024-01-01",
    yearEnd: "2024-03-15",
    recoveryPeriodYears: 5,
    method: "200_db",
    convention: "half_year",
  }, covered);
  assert.notEqual(walked.current.allowance, "0.00");
  const withoutSuccessor = assertMacrsWindowsCover([first], "2024-01-15", "2024-03-10");
  assert.deepEqual(
    withoutSuccessor.map((window) => `${window.yearStart}:${window.yearEnd}`),
    ["2024-01-01:2024-03-15"],
  );
  assert.equal(adjacentShortYearExclusion(withoutSuccessor, 0), false);
});

test("macrsWindowsPreservingAppliedContext seals successor absence only on the calculated year", () => {
  const calculated = { taxYear: 2024, yearStart: "2024-01-01", yearEnd: "2024-03-15" };
  const successor = { taxYear: 2024, yearStart: "2024-03-16", yearEnd: "2024-12-31" };
  const input = {
    basis: "10000",
    placedInServiceOn: "2024-01-15",
    taxYear: 2024,
    yearStart: "2024-01-01",
    yearEnd: "2024-03-15",
    recoveryPeriodYears: 5 as const,
    method: "200_db" as const,
    convention: "half_year" as const,
  };
  const vintage = {
    placedInServiceOn: "2024-01-15",
    unadjustedBasis: "10000.0000",
    recoveryPeriodYears: "5",
    method: "200_db" as const,
    convention: "half_year" as const,
    section179: "0.0000",
    bonusPercent: "0",
    businessUsePercent: "100",
    adjustedCarryover: null,
    priorDepreciation: null,
    transferOn: null,
  };
  const frozenWalk = computeMacrsThroughYear(input, [calculated]);
  const liveWalk = computeMacrsThroughYear(input, [calculated, successor]);
  assert.notEqual(liveWalk.current.allowance, frozenWalk.current.allowance);
  const preserved = macrsWindowsPreservingAppliedContext(
    [{ throughOn: "2024-03-10", windows: [calculated] }],
    [successor],
  );
  assert.equal(adjacentShortYearExclusion(preserved, 0), false);
  assert.equal(adjacentShortYearExclusion([calculated, successor], 0), true);
  const laterWalk = computeMacrsThroughYear(input, preserved);
  assert.equal(laterWalk.current.allowance, frozenWalk.current.allowance);
  const laterSetStillKeepsCalculatedAbsence = macrsWindowsPreservingAppliedContext(
    [
      { throughOn: "2024-03-10", windows: [calculated] },
      { throughOn: "2024-09-01", windows: [calculated, successor] },
    ],
    [],
  );
  assert.equal(adjacentShortYearExclusion(laterSetStillKeepsCalculatedAbsence, 0), false);
  assert.deepEqual(
    refreshOpenMacrsVintageThrough(vintage, preserved, "2024-03-10"),
    refreshOpenMacrsVintageThrough(vintage, [calculated], "2024-03-10"),
  );
  assert.notDeepEqual(
    refreshOpenMacrsVintageThrough(vintage, [calculated, successor], "2024-03-10"),
    refreshOpenMacrsVintageThrough(vintage, [calculated], "2024-03-10"),
  );
});

test("a mixed-entity evidence set seals the same-owner successor, not the next global row", () => {
  const transferor = {
    subsidiaryId: "A",
    regime: "us_macrs",
    taxYear: 2024,
    yearStart: "2024-01-01",
    yearEnd: "2024-03-15",
  };
  const receiver = {
    subsidiaryId: "B",
    regime: "us_macrs",
    taxYear: 2024,
    yearStart: "2024-03-01",
    yearEnd: "2024-12-31",
  };
  const transferorSuccessor = {
    subsidiaryId: "A",
    regime: "us_macrs",
    taxYear: 2024,
    yearStart: "2024-03-16",
    yearEnd: "2024-06-15",
  };
  const preserved = macrsWindowsPreservingAppliedContext(
    [{ throughOn: "2024-03-10", windows: [transferor, receiver, transferorSuccessor] }],
    [],
  );
  assert.equal(adjacentShortYearExclusion(preserved, 0), true);
  assert.deepEqual(preserved[0]?.frozenConventionSuccessor, {
    yearStart: "2024-03-16",
    yearEnd: "2024-06-15",
    subsidiaryId: "A",
    regime: "us_macrs",
  });
  assert.equal(adjacentShortYearExclusion([transferor, receiver, transferorSuccessor], 0), true);
});

test("a context-only successor does not freeze its own later convention absence", () => {
  const first = { taxYear: 2024, yearStart: "2024-01-01", yearEnd: "2024-03-15" };
  const context = { taxYear: 2024, yearStart: "2024-03-16", yearEnd: "2024-06-15" };
  const later = { taxYear: 2024, yearStart: "2024-06-16", yearEnd: "2024-12-31" };
  const preserved = macrsWindowsPreservingAppliedContext(
    [{ throughOn: "2024-03-10", windows: [first, context] }],
    [later],
  );
  assert.equal(adjacentShortYearExclusion(preserved, 0), true);
  assert.equal(adjacentShortYearExclusion(preserved, 1), true);
  const ifContextWereSealed = macrsWindowsPreservingAppliedContext(
    [{ throughOn: "2024-06-15", windows: [first, context] }],
    [later],
  );
  assert.equal(adjacentShortYearExclusion(ifContextWereSealed, 1), false);
});

test("a received vintage does not invent a receiver calendar before the transfer", () => {
  assert.deepEqual(
    macrsOwnershipWindowLoads({
      placedInServiceOn: "2023-03-15",
      transferOn: "2026-08-20",
      asOf: "2026-09-01",
      currentSubsidiaryId: "receiver",
      transferorSubsidiaryId: "transferor",
    }),
    [
      { subsidiaryId: "transferor", fromOn: "2023-03-15", throughOn: "2026-08-20" },
      { subsidiaryId: "receiver", fromOn: "2026-08-20", throughOn: "2026-09-01" },
    ],
  );
  assert.deepEqual(
    macrsOwnershipWindowLoads({
      placedInServiceOn: "2023-03-15",
      transferOn: null,
      asOf: "2026-09-01",
      currentSubsidiaryId: "receiver",
      transferorSubsidiaryId: null,
    }),
    [{ subsidiaryId: "receiver", fromOn: "2023-03-15", throughOn: "2026-09-01" }],
  );
});

test("a book-period hole is a refused gap, not a min/max tax year", () => {
  assert.throws(
    () => assertMacrsWindowsCover([
      { taxYear: 2024, yearStart: "2024-01-01", yearEnd: "2024-03-31" },
      { taxYear: 2024, yearStart: "2024-06-01", yearEnd: "2024-12-31" },
    ], "2024-01-01", "2024-12-31"),
    /gap between 2024-03-31 and 2024-06-01/,
  );
});

test("a 2026 transfer does not reuse a 2023 paper remaining as the buyer checkpoint", () => {
  const windows = macrsWindowsThroughFiscalCalendar({
    yearStartMonth: 1,
    fromOn: "2023-01-01",
    throughOn: "2026-09-01",
  });
  const vintage = {
    placedInServiceOn: "2023-01-01",
    unadjustedBasis: "10000.0000",
    recoveryPeriodYears: "5",
    method: "200_db" as const,
    convention: "half_year" as const,
    section179: "0.0000",
    bonusPercent: "0",
    businessUsePercent: "100",
    adjustedCarryover: null,
    priorDepreciation: "2000.0000",
    transferOn: null,
  };
  const dated = refreshOpenMacrsVintageThrough(vintage, windows, "2026-09-01");
  assert.notEqual(dated.adjustedCarryover, "8000.0000");
  assert.notEqual(dated.priorDepreciation, "2000.0000");
  const walked = computeMacrsThroughYear({
    basis: "10000.0000",
    placedInServiceOn: "2023-01-01",
    taxYear: 2026,
    recoveryPeriodYears: 5,
    method: "200_db",
    convention: "half_year",
    disposedOn: "2026-09-01",
    dispositionRecognition: "nontaxable",
    section168i7Kind: "nonrecognition",
  }, windows);
  assert.equal(
    dated.adjustedCarryover,
    formatMoney(remainingAfter(walked.prior.remainingBasis, walked.current.allowance), 4),
  );
  assert.equal(cmp(dated.priorDepreciation, "2000.0000") > 0, true);
  assert.notEqual(dated.adjustedCarryover, "0.0000");
});

test("excess or taxable prior is not left at zero across later recovery years", () => {
  const windows = macrsWindowsThroughFiscalCalendar({
    yearStartMonth: 1,
    fromOn: "2024-08-01",
    throughOn: "2026-09-01",
  });
  const dated = refreshOpenMacrsVintageThrough({
    placedInServiceOn: "2024-08-01",
    unadjustedBasis: "400.0000",
    recoveryPeriodYears: "7",
    method: "straight_line",
    convention: "mid_month",
    section179: "0.0000",
    bonusPercent: "0",
    businessUsePercent: "100",
    adjustedCarryover: null,
    priorDepreciation: "0.0000",
    transferOn: "2024-08-01",
  }, windows, "2026-09-01");
  assert.notEqual(dated.priorDepreciation, "0.0000");
  assert.notEqual(dated.adjustedCarryover, "400.0000");
});

test("1.1502-13 Example 4 consolidated later-year transfer continues the original schedule", () => {
  const windows = macrsWindowsThroughFiscalCalendar({
    yearStartMonth: 1,
    fromOn: "2023-01-01",
    throughOn: "2026-12-31",
  });
  const asset = {
    placedInServiceOn: "2023-01-01",
    unadjustedBasis: "10000.0000",
    recoveryPeriodYears: "5",
    method: "200_db" as const,
    convention: "half_year" as const,
    section179: "0.0000",
    bonusPercent: "0",
    businessUsePercent: "100",
    adjustedCarryover: null,
    priorDepreciation: null,
    transferOn: null,
    section168i7Kind: "consolidated_group" as const,
  };
  const dated = refreshOpenMacrsVintageThrough(asset, windows, "2025-08-20");
  const originalYear3Open = computeMacrsThroughYear({
    basis: "10000.0000",
    placedInServiceOn: "2023-01-01",
    taxYear: 2025,
    yearStart: "2025-01-01",
    yearEnd: "2025-12-31",
    recoveryPeriodYears: 5,
    method: "200_db",
    convention: "half_year",
  }, windows);
  const originalNext = computeMacrsThroughYear({
    basis: "10000.0000",
    placedInServiceOn: "2023-01-01",
    taxYear: 2026,
    yearStart: "2026-01-01",
    yearEnd: "2026-12-31",
    recoveryPeriodYears: 5,
    method: "200_db",
    convention: "half_year",
  }, windows);
  assert.equal(dated.adjustedCarryover, formatMoney(originalYear3Open.prior.remainingBasis, 4));
  assert.equal(dated.checkpointKind, "taken_components");
  assert.equal(
    formatMoney(sum([
      dated.section179,
      dated.takenBonus,
      dated.priorDepreciation,
      dated.adjustedCarryover,
    ]), 4),
    "10000.0000",
  );
  assert.equal(
    dated.priorDepreciation,
    formatMoney(add("10000.0000", neg(dated.adjustedCarryover)), 4),
  );
  const next = computeMacrsThroughYear({
    basis: "10000.0000",
    placedInServiceOn: "2023-01-01",
    taxYear: 2026,
    yearStart: "2026-01-01",
    yearEnd: "2026-12-31",
    recoveryPeriodYears: 5,
    method: "200_db",
    convention: "half_year",
    adjustedCarryover: dated.adjustedCarryover,
    carryoverOn: "2025-08-20",
    section168i7Kind: "consolidated_group",
  }, windows);
  assert.equal(next.currentRecoveryYearIndex, originalNext.currentRecoveryYearIndex);
  assert.equal(next.current.allowance, originalNext.current.allowance);
  assert.equal(next.current.remainingBasis, originalNext.current.remainingBasis);
  assert.equal(next.prior.remainingBasis, originalNext.prior.remainingBasis);
});

test("§168(i)(7) 9000 bonus split 5250/3750 dates without a negative prior", () => {
  const windows = [{ taxYear: 2018, yearStart: "2018-01-01", yearEnd: "2018-12-31" }];
  const dated = refreshOpenMacrsVintageThrough({
    placedInServiceOn: "2018-01-05",
    unadjustedBasis: "9000.0000",
    recoveryPeriodYears: "5",
    method: "200_db",
    convention: "half_year",
    section179: "0.0000",
    bonusPercent: "100",
    businessUsePercent: "100",
    adjustedCarryover: null,
    priorDepreciation: null,
    transferOn: null,
    section168i7Kind: "nonrecognition",
  }, windows, "2018-08-20");
  assert.equal(dated.checkpointKind, "taken_components");
  assert.equal(dated.section179, "0.0000");
  assert.equal(dated.takenBonus, "5250.0000");
  assert.equal(dated.priorDepreciation, "0.0000");
  assert.equal(dated.adjustedCarryover, "3750.0000");
  assert.equal(
    formatMoney(add(dated.takenBonus, dated.adjustedCarryover), 4),
    "9000.0000",
  );
});

test("a later-year transfer with an intervening short year continues the original recovery schedule", () => {
  const originalCalendar = [
    { taxYear: 2023, yearStart: "2023-01-01", yearEnd: "2023-12-31" },
    { taxYear: 2024, yearStart: "2024-01-01", yearEnd: "2024-06-30" },
    { taxYear: 2024, yearStart: "2024-07-01", yearEnd: "2024-12-31" },
    { taxYear: 2025, yearStart: "2025-01-01", yearEnd: "2025-12-31" },
    { taxYear: 2026, yearStart: "2026-01-01", yearEnd: "2026-12-31" },
  ];
  const transferor = originalCalendar.slice(0, 4).map((row) => ({
    ...row,
    subsidiaryId: "A",
    regime: "us_macrs",
  }));
  const receiver = [
    { subsidiaryId: "B", regime: "us_macrs", taxYear: 2025, yearStart: "2025-01-01", yearEnd: "2025-12-31" },
    { subsidiaryId: "B", regime: "us_macrs", taxYear: 2026, yearStart: "2026-01-01", yearEnd: "2026-12-31" },
  ];
  const lineage = [...transferor, ...receiver];
  const asset = {
    placedInServiceOn: "2023-01-01",
    unadjustedBasis: "10000.0000",
    recoveryPeriodYears: "5",
    method: "200_db" as const,
    convention: "half_year" as const,
    section179: "0.0000",
    bonusPercent: "0",
    businessUsePercent: "100",
    adjustedCarryover: null as string | null,
    priorDepreciation: null as string | null,
    transferOn: null as string | null,
    shortYearMethod: "simplified" as const,
    section168i7Kind: "nonrecognition" as const,
  };
  const dated = refreshOpenMacrsVintageThrough(asset, originalCalendar, "2025-08-20");
  const originalAtTransfer = computeMacrsThroughYear({
    basis: "10000.0000",
    placedInServiceOn: "2023-01-01",
    taxYear: 2025,
    yearStart: "2025-01-01",
    yearEnd: "2025-12-31",
    recoveryPeriodYears: 5,
    method: "200_db",
    convention: "half_year",
    shortYearMethod: "simplified",
    disposedOn: "2025-08-20",
    dispositionRecognition: "nontaxable",
    section168i7Kind: "nonrecognition",
  }, originalCalendar);
  assert.equal(
    dated.adjustedCarryover,
    formatMoney(remainingAfter(originalAtTransfer.prior.remainingBasis, originalAtTransfer.current.allowance), 4),
  );
  const walk = macrsLineageRecoveryWindows({
    windows: lineage,
    placedInServiceOn: "2023-01-01",
    transferOn: "2025-08-20",
    asOf: "2026-12-31",
    ownerSubsidiaryId: "B",
  });
  assert.deepEqual(walk.map((row) => `${row.subsidiaryId}:${row.yearStart}:${row.yearEnd}`), [
    "A:2023-01-01:2023-12-31",
    "A:2024-01-01:2024-06-30",
    "A:2024-07-01:2024-12-31",
    "A:2025-01-01:2025-12-31",
    "B:2026-01-01:2026-12-31",
  ]);
  const continued = {
    basis: "10000.0000",
    placedInServiceOn: "2023-01-01",
    taxYear: 2026,
    yearStart: "2026-01-01",
    yearEnd: "2026-12-31",
    recoveryPeriodYears: 5 as const,
    method: "200_db" as const,
    convention: "half_year" as const,
    shortYearMethod: "simplified" as const,
    adjustedCarryover: dated.adjustedCarryover,
    carryoverOn: "2025-08-20",
    section168i7Kind: "nonrecognition" as const,
  };
  const originalContinued = computeMacrsThroughYear(continued, originalCalendar);
  const receivedContinued = computeMacrsThroughYear(continued, walk);
  assert.equal(receivedContinued.currentRecoveryYearIndex, originalContinued.currentRecoveryYearIndex);
  assert.equal(receivedContinued.current.allowance, originalContinued.current.allowance);
  assert.equal(receivedContinued.current.remainingBasis, originalContinued.current.remainingBasis);
  assert.equal(receivedContinued.prior.remainingBasis, originalContinued.prior.remainingBasis);
  const collapsed = computeMacrsThroughYear(continued, [transferor[0]!, receiver[1]!]);
  assert.notEqual(collapsed.currentRecoveryYearIndex, originalContinued.currentRecoveryYearIndex);
  assert.notEqual(collapsed.current.allowance, originalContinued.current.allowance);
  const received = {
    ...asset,
    checkpointKind: dated.checkpointKind,
    section179: dated.section179,
    takenBonus: dated.takenBonus,
    adjustedCarryover: dated.adjustedCarryover,
    priorDepreciation: dated.priorDepreciation,
    transferOn: "2025-08-20",
  };
  const datedThrough2026 = refreshOpenMacrsVintageThrough(received, lineage, "2026-12-31", {
    ownerSubsidiaryId: "B",
  });
  const originalThrough2026 = refreshOpenMacrsVintageThrough(received, originalCalendar, "2026-12-31");
  assert.equal(datedThrough2026.adjustedCarryover, originalThrough2026.adjustedCarryover);
  assert.equal(datedThrough2026.priorDepreciation, originalThrough2026.priorDepreciation);
  assert.throws(
    () => macrsLineageRecoveryWindows({
      windows: [transferor[0]!, receiver[1]!],
      placedInServiceOn: "2023-01-01",
      transferOn: "2025-08-20",
      asOf: "2026-12-31",
      ownerSubsidiaryId: "B",
    }),
    /no tax year window covers 2025-08-20|gap between/,
  );
});

test("mid-quarter 40% uses the tax window's last three months and vintage tax basis", () => {
  const fiscal = { taxYear: 2026, yearStart: "2025-07-01", yearEnd: "2026-06-30" };
  assert.equal(lastThreeMonthsStart("2026-06-30"), "2026-04-01");
  assert.equal(lastThreeMonthsStart("2025-12-31"), "2025-10-01");
  const may = { placedInServiceOn: "2026-05-01", basis: "6000", disposedOn: null, convention: "half_year" as const };
  const august = { placedInServiceOn: "2025-08-01", basis: "4000", disposedOn: null, convention: "half_year" as const };
  assert.equal(macrsMidQuarterApplies(fiscal, [
    { placedOn: may.placedInServiceOn, basis: may.basis },
    { placedOn: august.placedInServiceOn, basis: august.basis },
  ]), true);
  const calendarOct = { taxYear: 2025, yearStart: "2025-01-01", yearEnd: "2025-12-31" };
  assert.equal(macrsMidQuarterApplies(calendarOct, [
    { placedOn: "2025-11-01", basis: "10000" },
  ]), true);
  const short = { taxYear: 2025, yearStart: "2025-01-01", yearEnd: "2025-03-31" };
  assert.equal(macrsMidQuarterApplies(short, [{ placedOn: "2025-01-15", basis: "1000" }]), true);
  const split = [
    { placedInServiceOn: "2025-08-01", basis: "1000", disposedOn: "2026-01-15", convention: "half_year" as const, recognition: "taxable" as const },
    { placedInServiceOn: "2026-05-01", basis: "9000", disposedOn: null, convention: "half_year" as const },
  ];
  assert.deepEqual(
    eligibleMacrsMidQuarterPlacements(split, fiscal),
    [{ placedOn: "2026-05-01", basis: "9000" }],
  );
  const retained = macrsMidQuarterByWindow([fiscal], split);
  assert.equal(retained.get(macrsWindowIdentity(fiscal)), true);
  const convention = macrsConventionAfterMidQuarter(
    may,
    "half_year",
    [fiscal],
    new Map([[macrsWindowIdentity(fiscal), true]]),
  );
  assert.equal(convention, "mid_quarter");
});

test("same-label short years keep distinct mid-quarter determinations", () => {
  const first = {
    id: "win-2024a",
    taxYear: 2024,
    yearStart: "2024-01-01",
    yearEnd: "2024-06-30",
  };
  const second = {
    id: "win-2024b",
    taxYear: 2024,
    yearStart: "2024-07-01",
    yearEnd: "2024-12-31",
  };
  const january = {
    placedInServiceOn: "2024-01-15",
    basis: "10000",
    disposedOn: null,
    convention: "half_year" as const,
  };
  const november = {
    placedInServiceOn: "2024-11-01",
    basis: "10000",
    disposedOn: null,
    convention: "half_year" as const,
  };
  assert.equal(macrsMidQuarterApplies(first, [{ placedOn: january.placedInServiceOn, basis: january.basis }]), false);
  assert.equal(macrsMidQuarterApplies(second, [{ placedOn: november.placedInServiceOn, basis: november.basis }]), true);
  const byWindow = macrsMidQuarterByWindow([first, second], [january, november]);
  assert.equal(byWindow.get(macrsWindowIdentity(first)), false);
  assert.equal(byWindow.get(macrsWindowIdentity(second)), true);
  assert.notEqual(macrsWindowIdentity(first), macrsWindowIdentity(second));
  assert.equal(
    macrsConventionAfterMidQuarter(january, "half_year", [first, second], byWindow),
    "half_year",
  );
  assert.equal(
    macrsConventionAfterMidQuarter(november, "half_year", [first, second], byWindow),
    "mid_quarter",
  );
});

test("§168(i)(7) placement-year bonus is allocated by months held, not ordinary HY disposal", () => {
  // IRS 2019-41 Example 2 XX/BC: Jan 5 place, Aug 20 §721 transfer, $9,000 bonus.
  const held = section168i7HeldMonths({
    placedInServiceOn: "2018-01-05",
    transferredOn: "2018-08-20",
    yearStart: "2018-01-01",
    yearEnd: "2018-12-31",
  });
  assert.equal(held.sellerMonths, 7);
  assert.equal(held.inServiceMonths, 12);
  const windows = [{ taxYear: 2018, yearStart: "2018-01-01", yearEnd: "2018-12-31" }];
  const buyer = computeMacrsThroughYear({
    basis: "9000",
    placedInServiceOn: "2018-01-05",
    taxYear: 2018,
    recoveryPeriodYears: 5,
    method: "200_db",
    convention: "half_year",
    bonusPercent: 100,
    adjustedCarryover: "3750.00",
    carryoverOn: "2018-08-20",
    section168i7Kind: "nonrecognition",
  }, windows);
  assert.equal(buyer.current.bonus, "3750.00");
  assert.equal(buyer.current.section179, "0.00");
  assert.equal(buyer.current.macrs, "0.00");
  assert.equal(buyer.current.allowance, "3750.00");
  assert.equal(buyer.current.remainingBasis, "0.00");
  assert.equal(
    formatMoney(add(add(buyer.current.section179, buyer.current.bonus), buyer.current.macrs), 2),
    buyer.current.allowance,
  );
  const seller = computeMacrsThroughYear({
    basis: "9000",
    placedInServiceOn: "2018-01-05",
    taxYear: 2018,
    recoveryPeriodYears: 5,
    method: "200_db",
    convention: "half_year",
    bonusPercent: 100,
    disposedOn: "2018-08-20",
    dispositionRecognition: "nontaxable",
    section168i7Kind: "nonrecognition",
  }, windows);
  assert.equal(seller.current.bonus, "5250.00");
  assert.equal(seller.current.allowance, "5250.00");
  assert.notEqual(buyer.current.allowance, "0.00");
});

test("a consolidated-group placement-year transfer does not monthly-split the year", () => {
  const buyer = computeMacrsThroughYear({
    basis: "9000",
    placedInServiceOn: "2018-01-05",
    taxYear: 2018,
    recoveryPeriodYears: 5,
    method: "200_db",
    convention: "half_year",
    bonusPercent: 100,
    adjustedCarryover: "3750.00",
    carryoverOn: "2018-08-20",
    section168i7Kind: "consolidated_group",
  }, [{ taxYear: 2018, yearStart: "2018-01-01", yearEnd: "2018-12-31" }]);
  assert.equal(buyer.current.allowance, "0.00");
  assert.equal(buyer.current.bonus, "0.00");
  assert.equal(buyer.current.remainingBasis, "3750.0000");
});

test("a §721 prior-partner depreciable interest keeps bonus with the transferor", () => {
  const buyer = computeMacrsThroughYear({
    basis: "9000",
    placedInServiceOn: "2018-01-05",
    taxYear: 2018,
    recoveryPeriodYears: 5,
    method: "200_db",
    convention: "half_year",
    bonusPercent: 100,
    adjustedCarryover: "0.00",
    carryoverOn: "2018-08-20",
    section168i7Kind: "partnership_721_prior_interest",
  }, [{ taxYear: 2018, yearStart: "2018-01-01", yearEnd: "2018-12-31" }]);
  assert.equal(buyer.current.bonus, "0.00");
  assert.equal(buyer.current.allowance, "0.00");
});

test("after a short year a later-year transfer reuses beginning-of-window remaining life", () => {
  const windows = [
    { taxYear: 2023, yearStart: "2023-07-01", yearEnd: "2023-12-31" },
    { taxYear: 2024, yearStart: "2024-01-01", yearEnd: "2024-12-31" },
    { taxYear: 2025, yearStart: "2025-01-01", yearEnd: "2025-12-31" },
    { taxYear: 2026, yearStart: "2026-01-01", yearEnd: "2026-12-31" },
  ];
  const input = {
    basis: "10000",
    placedInServiceOn: "2023-07-01",
    recoveryPeriodYears: 5 as const,
    method: "straight_line" as const,
    convention: "half_year" as const,
    adjustedCarryover: "7500.00",
    carryoverOn: "2025-07-01",
    section168i7Kind: "nonrecognition" as const,
  };
  const annual = subsequentRecoveryDeduction({
    method: "straight_line",
    recoveryPeriodYears: "5",
    originalMacrsBasis: "10000",
    adjustedBasis: "7500.00",
    elapsedMonths: 15,
    monthsThisYear: 12,
    shortYearMethod: "simplified",
  });
  const seller = subsequentRecoveryDeduction({
    method: "straight_line",
    recoveryPeriodYears: "5",
    originalMacrsBasis: "10000",
    adjustedBasis: "7500.00",
    elapsedMonths: 15,
    monthsThisYear: 6,
    shortYearMethod: "simplified",
  });
  const residual = formatMoney(add(annual, neg(seller)), 2);
  const nextOpening = remainingAfter("7500.00", residual);
  const nextAnnual = subsequentRecoveryDeduction({
    method: "straight_line",
    recoveryPeriodYears: "5",
    originalMacrsBasis: "10000",
    adjustedBasis: nextOpening,
    elapsedMonths: 27,
    monthsThisYear: 12,
    shortYearMethod: "simplified",
  });
  const transferYear = computeMacrsThroughYear({ ...input, taxYear: 2025 }, windows);
  const nextYear = computeMacrsThroughYear({ ...input, taxYear: 2026 }, windows);
  assert.equal(annual, "2000.00");
  assert.equal(seller, "1000.00");
  assert.equal(transferYear.current.allowance, residual);
  assert.equal(transferYear.current.remainingBasis, nextOpening);
  assert.equal(nextYear.prior.remainingBasis, transferYear.current.remainingBasis);
  assert.equal(nextYear.current.allowance, nextAnnual);
  assert.notEqual(transferYear.current.allowance, formatMoney(mulRatio("7500.00", 6n, 33n), 2));
});

test("regimes that disallow recapture (Canada Class 10.1) just zero the pool", () => {
  const r = run({ openingBalance: "1000", dispositions: "5000", allowRecapture: false });
  assert.equal(r.recapture, "0.00");
  assert.equal(r.closingBalance, "0.00");
});

test("immediate expensing fully deducts before the rate", () => {
  const r = run({ additions: "100000", immediateExpense: "100000", rate: 0.55, firstYearFraction: 0.5 });
  assert.equal(r.immediateExpense, "100000.00");
  assert.equal(r.allowance, "0.00");
  assert.equal(r.closingBalance, "0.00");
});

// The Canada CCA regime is data, driving the same generic engine.
test("Canada CCA is a configured regime, not hardcoded logic", () => {
  const c8 = resolvePoolClass("ca_cca", "8")!;
  assert.equal(c8.rate, 0.2);
  assert.equal(c8.firstYearFraction, 0.5); // half-year rule
  assert.equal(resolvePoolClass("ca_cca", "50")!.rate, 0.55);
  assert.equal(resolvePoolClass("ca_cca", "10.1")!.allowRecapture, false);
  assert.equal(TAX_DEPRECIATION_REGIMES.ca_cca!.name, "Canada — Capital Cost Allowance");

  // Run a real Class 8 year straight from the regime config.
  const r = computePoolYear({
    openingBalance: "0", additions: "10000", dispositions: "0",
    rate: c8.rate, firstYearFraction: c8.firstYearFraction,
  });
  assert.equal(r.allowance, "1000.00");
});
