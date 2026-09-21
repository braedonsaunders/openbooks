import assert from "node:assert/strict";
import test from "node:test";
import { add, cmp, formatMoney, sum } from "../money/money.ts";
import {
  computeMacrsThroughYear,
  refreshOpenMacrsVintageThrough,
  type MacrsYearInput,
  type MacrsYearWindow,
} from "./depreciation-pool.ts";

const calendar = (first: number, last: number): MacrsYearWindow[] =>
  Array.from({ length: last - first + 1 }, (_, offset) => ({
    taxYear: first + offset,
    yearStart: `${first + offset}-01-01`,
    yearEnd: `${first + offset}-12-31`,
  }));

const input: MacrsYearInput = {
  basis: "10000.0000", placedInServiceOn: "2023-01-01", taxYear: 2025,
  recoveryPeriodYears: "5", method: "200_db", convention: "half_year",
  section179: "0", bonusPercent: "0", businessUsePercent: "100",
  adjustedCarryover: "4800.0000", carryoverOn: "2025-01-01",
  section168i7Kind: "nonrecognition",
};

const moneyEqual = (actual: string, expected: string, message: string) =>
  assert.equal(formatMoney(actual, 4), formatMoney(expected, 4), message);

test("disjoint reporting windows conserve a recovery-year allowance when they split one month", () => {
  const recovery = calendar(2023, 2025);
  const reporting = [
    { taxYear: 2025, yearStart: "2025-01-01", yearEnd: "2025-07-15" },
    { taxYear: 2025, yearStart: "2025-07-16", yearEnd: "2025-12-31" },
  ];
  const annual = computeMacrsThroughYear({ ...input, ...recovery[2]! }, recovery);
  const first = computeMacrsThroughYear({ ...input, ...reporting[0]! }, recovery, reporting);
  const second = computeMacrsThroughYear({ ...input, ...reporting[1]! }, recovery, reporting);
  moneyEqual(annual.current.allowance, "1920.00", "the reference calendar-year amount has a known statutory schedule");
  moneyEqual(add(first.current.allowance, second.current.allowance), annual.current.allowance,
    "July belongs once across July15/July16, not seven months plus six months");
  moneyEqual(second.prior.remainingBasis, first.current.remainingBasis,
    "a later reporting window must open at the earlier window's close");
  moneyEqual(second.current.remainingBasis, annual.current.remainingBasis,
    "partitioning a reporting year cannot change the recovered basis");
  moneyEqual(second.takenMacrs, add(first.current.macrs, second.current.macrs),
    "cumulative taken regular depreciation must equal the amounts actually assigned to the windows");
});

test("reporting allocation does not erase an exact subcent final checkpoint", () => {
  const recovery = calendar(2020, 2025);
  const reporting = [
    { taxYear: 2025, yearStart: "2025-01-01", yearEnd: "2025-06-30" },
    { taxYear: 2025, yearStart: "2025-07-01", yearEnd: "2025-12-31" },
  ];
  const exact: MacrsYearInput = {
    ...input, basis: "1250.0000", placedInServiceOn: "2020-01-01", adjustedCarryover: "0.0001",
  };
  const annual = computeMacrsThroughYear({ ...exact, ...recovery[5]! }, recovery);
  const first = computeMacrsThroughYear({ ...exact, ...reporting[0]! }, recovery, reporting);
  const second = computeMacrsThroughYear({ ...exact, ...reporting[1]! }, recovery, reporting);
  moneyEqual(annual.current.allowance, "0.0001", "a deduction must cap at the exact remaining rather than erase it");
  moneyEqual(add(first.current.allowance, second.current.allowance), "0.0001",
    "the reporting split must carry its rounding remainder rather than drop it in both halves");
  moneyEqual(second.current.remainingBasis, "0", "a fully recovered exact checkpoint must not become a permanent residue");
  for (const result of [first, second]) {
    moneyEqual(sum([result.current.section179, result.current.bonus, result.current.macrs]), result.current.allowance,
      "a clipped allowance must still equal its named components");
    assert.ok(cmp(result.current.allowance, result.prior.remainingBasis) <= 0,
      "a reporting deduction cannot exceed its exact opening");
    moneyEqual(add(result.current.allowance, result.current.remainingBasis), result.prior.remainingBasis,
      "a reporting deduction and remaining must conserve the exact opening");
  }
});

test("a fully disposed vintage is not resurrected by the receiving reporting calendar", () => {
  const recovery = calendar(2023, 2025);
  const reporting = [{ taxYear: 2025, yearStart: "2025-01-01", yearEnd: "2025-06-30" }];
  const result = computeMacrsThroughYear({
    ...input, ...reporting[0]!, disposedOn: "2025-05-20", dispositionRecognition: "taxable",
  }, recovery, reporting);
  moneyEqual(result.current.remainingBasis, "0",
    "the whole vintage has left before reporting year end; unrecovered basis is a disposition, not retained basis");
  assert.ok(cmp(result.current.allowance, "0") > 0,
    "the disposition must not erase the allowed service-period deduction");
});

test("received history is refreshed at the source date rather than at the enclosing year end", () => {
  const vintage = {
    placedInServiceOn: "2023-03-15", unadjustedBasis: "10000.0000",
    recoveryPeriodYears: "5", method: "200_db" as const, convention: "half_year" as const,
    section179: "0", bonusPercent: "0", businessUsePercent: "100",
    priorDepreciation: "7696.0000", adjustedCarryover: "2304.0000", transferOn: "2026-07-01",
    checkpointKind: "declared_elections" as const, takenBonus: null,
    shortYearMethod: "allocation" as const, section168i7Kind: "nonrecognition" as const,
  };
  const windows = calendar(2023, 2026);
  const atSource = refreshOpenMacrsVintageThrough(vintage, windows, "2026-07-20");
  moneyEqual(atSource.adjustedCarryover, "2304.0000",
    "an onward transfer in the receiving month must not take the rest of the reporting year's depreciation");
  moneyEqual(atSource.priorDepreciation, "7696.0000",
    "future deductions cannot be frozen as already taken on July20");
  moneyEqual(sum([atSource.section179, atSource.takenBonus, atSource.priorDepreciation, atSource.adjustedCarryover]),
    "10000.0000", "source-date history must conserve the original statutory basis");
});
