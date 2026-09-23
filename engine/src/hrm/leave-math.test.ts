import assert from "node:assert/strict";
import test from "node:test";
import {
  accrualEarned,
  accrualEarnedAcrossSegments,
  addHours,
  carryoverApplied,
  cmpHours,
  eachDayOfRange,
  formatCents,
  parseHoursToCents,
  rangesOverlap,
  selectPolicy,
  splitHoursAcrossDays,
  subHours,
  timeBalance,
  wholePeriodsElapsed,
} from "./leave-math.ts";

/**
 * Pure leave math — no database. Exact bigint-hundredths arithmetic: a
 * balance that reads 7.30 while its days sum 7.29 is a payroll dispute, so
 * floats never touch these paths.
 */

test("hours parse and format round-trip exactly", () => {
  assert.equal(formatCents(parseHoursToCents("7.30")), "7.3");
  assert.equal(formatCents(parseHoursToCents("0.05")), "0.05");
  assert.equal(formatCents(parseHoursToCents("120")), "120");
  assert.equal(addHours("0.1", "0.2"), "0.3");
  assert.equal(subHours("1.00", "0.07"), "0.93");
  assert.equal(cmpHours("7.3", "7.30"), 0);
  assert.equal(cmpHours("7.29", "7.3"), -1);
  assert.equal(cmpHours("8", "7.99"), 1);
});

test("hours refuse non-exact input by name", () => {
  assert.throws(() => parseHoursToCents("12,34"), /at most 2 fraction digits/);
  assert.throws(() => parseHoursToCents("1.234"), /at most 2 fraction digits/);
  assert.throws(() => parseHoursToCents("eight"), /at most 2 fraction digits/);
  assert.throws(() => parseHoursToCents(""), /at most 2 fraction digits/);
});

test("day ranges walk the civil grid, leap-aware", () => {
  assert.deepEqual(eachDayOfRange("2026-02-27", "2026-03-01"), [
    "2026-02-27",
    "2026-02-28",
    "2026-03-01",
  ]);
  assert.deepEqual(eachDayOfRange("2024-02-28", "2024-03-01"), [
    "2024-02-28",
    "2024-02-29",
    "2024-03-01",
  ]);
  assert.deepEqual(eachDayOfRange("2026-12-31", "2027-01-01"), ["2026-12-31", "2027-01-01"]);
  assert.deepEqual(eachDayOfRange("2026-05-05", "2026-05-05"), ["2026-05-05"]);
  assert.throws(() => eachDayOfRange("2026-05-06", "2026-05-05"), /must not be before start/);
  assert.throws(() => eachDayOfRange("not-a-date", "2026-05-05"), /invalid civil date/);
});

test("inclusive overlap collides on a shared boundary day", () => {
  assert.equal(rangesOverlap("2026-06-01", "2026-06-05", "2026-06-05", "2026-06-10"), true);
  assert.equal(rangesOverlap("2026-06-01", "2026-06-05", "2026-06-06", "2026-06-10"), false);
  assert.equal(rangesOverlap("2026-06-01", "2026-06-10", "2026-06-03", "2026-06-04"), true);
});

test("accrual earns by kind, pro-rated by whole periods", () => {
  assert.equal(accrualEarned({ kind: "none" }, "2026-01-01", "2026-06-01"), "0");
  assert.equal(accrualEarned({ kind: "unlimited" }, "2026-01-01", "2026-06-01"), null);
  assert.equal(accrualEarned({ kind: "per_year", hours: "120" }, "2026-01-01", "2026-06-01"), "120");
  // Monthly pro-rate: nothing earned before the first slice completes.
  assert.equal(
    accrualEarned({ kind: "per_period", hours: "10", periods_per_year: 12 }, "2026-01-01", "2026-01-15"),
    "0",
  );
  assert.equal(
    accrualEarned({ kind: "per_period", hours: "10", periods_per_year: 12 }, "2026-01-01", "2026-06-30"),
    "50",
  );
  assert.equal(
    accrualEarned({ kind: "per_period", hours: "10", periods_per_year: 12 }, "2026-01-01", "2026-12-31"),
    "120",
  );
});

test("accrual refuses undeclared rules instead of earning zero", () => {
  assert.throws(() => accrualEarned({ kind: "per_year" }, "2026-01-01", "2026-06-01"), /must carry hours/);
  assert.throws(() => accrualEarned({ kind: "per_period", hours: "10" }, "2026-01-01", "2026-06-01"), /periods_per_year/);
  assert.throws(
    () => accrualEarned({ kind: "per_period", hours: "10", periods_per_year: 0 }, "2026-01-01", "2026-06-01"),
    /periods_per_year/,
  );
  assert.throws(() => accrualEarned({ kind: "per_year", hours: "120" }, "2026-06-01", "2026-01-01"), /precedes accrual year/);
});

test("carryover caps and expires, never negative", () => {
  assert.equal(carryoverApplied({ kind: "none" }, "40", "2026-01-01", "2026-03-01"), "0");
  assert.equal(carryoverApplied({ kind: "carry_all" }, "40", "2026-01-01", "2026-03-01"), "40");
  assert.equal(carryoverApplied({ kind: "carry_up_to", hours: "24" }, "40", "2026-01-01", "2026-03-01"), "24");
  assert.equal(carryoverApplied({ kind: "carry_up_to", hours: "24" }, "10", "2026-01-01", "2026-03-01"), "10");
  assert.equal(
    carryoverApplied({ kind: "carry_all", expires_after_days: 60 }, "40", "2026-01-01", "2026-04-01"),
    "0",
  );
  assert.equal(carryoverApplied({ kind: "carry_all" }, "0", "2026-01-01", "2026-03-01"), "0");
  assert.throws(() => carryoverApplied({ kind: "carry_up_to" }, "40", "2026-01-01", "2026-03-01"), /must carry hours/);
});

test("time balance nets earned plus carried minus taken, unlimited stays null", () => {
  assert.equal(timeBalance({ earned: "120", carried: "10", taken: "30" }), "100");
  assert.equal(timeBalance({ earned: "0", carried: "0", taken: "0" }), "0");
  assert.equal(timeBalance({ earned: null, carried: "0", taken: "999" }), null);
});

test("policy precedence is most-specific, then latest", () => {
  const org = { id: "org", employerSubsidiaryId: null, departmentId: null, effectiveFrom: "2026-01-01" };
  const sub = { id: "sub", employerSubsidiaryId: "s1", departmentId: null, effectiveFrom: "2026-01-01" };
  const dept = { id: "dept", employerSubsidiaryId: null, departmentId: "d1", effectiveFrom: "2026-01-01" };
  const exact = { id: "exact", employerSubsidiaryId: "s1", departmentId: "d1", effectiveFrom: "2026-01-01" };
  const scope = { employerSubsidiaryId: "s1", departmentId: "d1" };
  assert.equal(selectPolicy([org, sub, dept, exact], scope, "2026-06-01")?.id, "exact");
  assert.equal(selectPolicy([org, sub, dept], scope, "2026-06-01")?.id, "sub");
  assert.equal(
    selectPolicy([org, { ...dept, employerSubsidiaryId: null }], { employerSubsidiaryId: "s9", departmentId: "d1" }, "2026-06-01")?.id,
    "dept",
  );
  assert.equal(selectPolicy([org], scope, "2026-06-01")?.id, "org");
  assert.equal(selectPolicy([org], scope, "2025-06-01"), null);
  const newer = { id: "newer", employerSubsidiaryId: "s1", departmentId: "d1", effectiveFrom: "2026-03-01" };
  assert.equal(selectPolicy([exact, newer], scope, "2026-06-01")?.id, "newer");
});

test("day splits are exact: first days take the remainder penny", () => {
  assert.deepEqual(splitHoursAcrossDays("8", 3), ["2.67", "2.67", "2.66"]);
  assert.deepEqual(splitHoursAcrossDays("7.5", 2), ["3.75", "3.75"]);
  const parts = splitHoursAcrossDays("10", 7);
  assert.equal(parts.reduce((sum, part) => addHours(sum, part), "0"), "10");
  assert.throws(() => splitHoursAcrossDays("8", 0), /positive whole day count/);
});

test("segmented accrual earns the old rate before a mid-year switch, the new rate after", () => {
  const first = { rule: { kind: "per_period" as const, hours: "8", periods_per_year: 12 }, from: "2026-01-01", to: "2026-06-30" };
  const second = { rule: { kind: "per_period" as const, hours: "16", periods_per_year: 12 }, from: "2026-07-01", to: null };
  // 6 × 8 + 6 × 16 = 144 — the current rule backdated to January would read 192.
  assert.equal(accrualEarnedAcrossSegments([first, second], "2026-01-01", "2026-12-31"), "144");
  // Only whole slices vest: five complete by Jun 30, the sixth (~Jul 2) vests
  // at the old rate once complete, the July slice only once August opens it.
  assert.equal(accrualEarnedAcrossSegments([first, second], "2026-01-01", "2026-06-30"), "40");
  assert.equal(accrualEarnedAcrossSegments([first, second], "2026-01-01", "2026-07-31"), "48");
});

test("segmented accrual matches the single-policy rule when nothing changed", () => {
  const only = { rule: { kind: "per_period" as const, hours: "8", periods_per_year: 12 }, from: "2026-01-01", to: null };
  assert.equal(
    accrualEarnedAcrossSegments([only], "2026-01-01", "2026-12-31"),
    accrualEarned({ kind: "per_period", hours: "8", periods_per_year: 12 }, "2026-01-01", "2026-12-31"),
  );
});

test("segmented accrual earns nothing across a coverage gap", () => {
  const first = { rule: { kind: "per_period" as const, hours: "8", periods_per_year: 12 }, from: "2026-01-01", to: "2026-06-30" };
  const second = { rule: { kind: "per_period" as const, hours: "16", periods_per_year: 12 }, from: "2026-09-01", to: null };
  // July and August complete no credited slice: 6 × 8 + 4 × 16 = 112.
  assert.equal(accrualEarnedAcrossSegments([first, second], "2026-01-01", "2026-12-31"), "112");
});

test("per_year grants vest to the segment holding the date", () => {
  const first = { rule: { kind: "per_year" as const, hours: "80" }, from: "2026-01-01", to: "2026-06-30" };
  const second = { rule: { kind: "per_year" as const, hours: "120" }, from: "2026-07-01", to: null };
  assert.equal(accrualEarnedAcrossSegments([first, second], "2026-01-01", "2026-06-01"), "80");
  assert.equal(accrualEarnedAcrossSegments([first, second], "2026-01-01", "2026-12-31"), "120");
});

test("any unlimited segment makes the year unbounded, empty coverage earns zero", () => {
  const capped = { rule: { kind: "per_period" as const, hours: "8", periods_per_year: 12 }, from: "2026-07-01", to: null };
  const open = { rule: { kind: "unlimited" as const }, from: "2026-01-01", to: "2026-06-30" };
  assert.equal(accrualEarnedAcrossSegments([open, capped], "2026-01-01", "2026-12-31"), null);
  assert.equal(accrualEarnedAcrossSegments([], "2026-01-01", "2026-12-31"), "0");
  assert.equal(
    accrualEarnedAcrossSegments([{ rule: { kind: "none" as const }, from: "2026-01-01", to: null }], "2026-01-01", "2026-12-31"),
    "0",
  );
});

test("selection breaks exact effective_from ties by id", () => {
  const scope = { employerSubsidiaryId: "s1", departmentId: "d1" };
  const a = { id: "b-id", employerSubsidiaryId: "s1", departmentId: "d1", effectiveFrom: "2026-01-01" };
  const b = { id: "a-id", employerSubsidiaryId: "s1", departmentId: "d1", effectiveFrom: "2026-01-01" };
  assert.equal(selectPolicy([a, b], scope, "2026-06-01")?.id, "a-id");
  assert.equal(selectPolicy([b, a], scope, "2026-06-01")?.id, "a-id");
});

test("selection skips policies whose window ended before the date", () => {
  const scope = { employerSubsidiaryId: "s1", departmentId: "d1" };
  const old = { id: "old", employerSubsidiaryId: null, departmentId: null, effectiveFrom: "2025-01-01", effectiveTo: "2025-12-31" };
  const current = { id: "current", employerSubsidiaryId: null, departmentId: null, effectiveFrom: "2026-01-01", effectiveTo: null };
  assert.equal(selectPolicy([old, current], scope, "2026-06-01")?.id, "current");
  assert.equal(selectPolicy([old], scope, "2026-06-01"), null);
});

test("whole periods elapsed clamps to the year", () => {
  assert.equal(wholePeriodsElapsed("2026-01-01", "2026-01-01", 12), 0);
  assert.equal(wholePeriodsElapsed("2026-01-01", "2026-12-31", 12), 12);
  assert.equal(wholePeriodsElapsed("2026-01-01", "2027-06-01", 12), 12);
  assert.equal(wholePeriodsElapsed("2026-01-01", "2026-12-31", 1), 1);
});
