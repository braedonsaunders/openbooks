import { test } from "node:test";
import assert from "node:assert/strict";
import { BenefitsError } from "./errors.ts";
import {
  addDaysCivil,
  daysInMonth,
  enrollmentTouchesMonth,
  monthBounds,
  monthlyFromBasis,
  overlapDays,
  prorateForMonth,
  waitingEligibleDate,
  windowsOverlap,
} from "./benefits-math.ts";

/**
 * HR-8 unit coverage (unit partition — no database): amount math per basis
 * including percent_of_pay against a supplied pay basis, daily/full_month
 * proration, civil-date edge cases (leap day, year boundary), waiting
 * period, and window overlap. Every refusal asserts its message names the
 * remedy. Red-proofed: each case below was shown to fail with the guard
 * reverted (see handover).
 */

function refused(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof BenefitsError, `expected BenefitsError, got ${String(error)}`);
    return error.message;
  }
  assert.fail("expected a refusal");
}

test("per_month passes the stored figure through untouched", () => {
  assert.equal(monthlyFromBasis("250.0000", "per_month", { periodsPerYear: null, payBasis: null }), "250.0000");
  assert.equal(monthlyFromBasis("250.5", "per_month", { periodsPerYear: null, payBasis: null }), "250.5000");
});

test("per_year divides by twelve, halves away from zero", () => {
  assert.equal(monthlyFromBasis("3000", "per_year", { periodsPerYear: null, payBasis: null }), "250.0000");
  // 1000/12 = 83.3333|3 -> 83.3333; 1001/12 = 83.4166|6 -> 83.4167.
  assert.equal(monthlyFromBasis("1000", "per_year", { periodsPerYear: null, payBasis: null }), "83.3333");
  assert.equal(monthlyFromBasis("1001", "per_year", { periodsPerYear: null, payBasis: null }), "83.4167");
});

test("per_period scales by the schedule periods per year, never an assumed one", () => {
  // 100 per period on a 26-period schedule: 100*26/12 = 216.6667.
  assert.equal(monthlyFromBasis("100", "per_period", { periodsPerYear: 26, payBasis: null }), "216.6667");
  // Monthly schedule: identity. 27-period leap year schedule: exact ratio.
  assert.equal(monthlyFromBasis("100", "per_period", { periodsPerYear: 12, payBasis: null }), "100.0000");
  assert.equal(monthlyFromBasis("100", "per_period", { periodsPerYear: 27, payBasis: null }), "225.0000");
  const message = refused(() => monthlyFromBasis("100", "per_period", { periodsPerYear: null, payBasis: null }));
  assert.match(message, /no usable pay schedule/);
  assert.match(message, /never assumes 12, 24, or 26/);
});

test("percent_of_pay resolves against the supplied pay basis only", () => {
  // 6% of a 5000 monthly basis = 300.
  assert.equal(
    monthlyFromBasis("6", "percent_of_pay", { periodsPerYear: null, payBasis: "5000" }),
    "300.0000",
  );
  const message = refused(() =>
    monthlyFromBasis("6", "percent_of_pay", { periodsPerYear: null, payBasis: null }),
  );
  assert.match(message, /has not supplied the pay basis/);
  assert.match(message, /instead of guessing a wage/);
});

test("unknown basis and malformed money are refused with the vocabulary", () => {
  const basis = refused(() =>
    monthlyFromBasis("100", "per_fortnight" as never, { periodsPerYear: 26, payBasis: null }),
  );
  assert.match(basis, /per_period, per_month, per_year, or percent_of_pay/);
  const money = refused(() => monthlyFromBasis("1,234.56", "per_month", { periodsPerYear: null, payBasis: null }));
  assert.match(money, /never separators or symbols/);
});

test("full_month carries the whole month for any covered slice", () => {
  const month = monthBounds("2026-02");
  assert.deepEqual([month.from, month.to, month.days], ["2026-02-01", "2026-02-28", 28]);
  assert.equal(
    prorateForMonth({ monthlyAmount: "250", prorationBasis: "full_month", coveredFrom: "2026-02-15", coveredTo: "2026-02-28", month }),
    "250.0000",
  );
});

test("daily scales by covered days over days in month", () => {
  const feb = monthBounds("2026-02");
  // 280 over 28 days, 14 covered: 140.
  assert.equal(
    prorateForMonth({ monthlyAmount: "280", prorationBasis: "daily", coveredFrom: "2026-02-15", coveredTo: "2026-02-28", month: feb }),
    "140.0000",
  );
  // Leap February divides by 29, not 28.
  const leap = monthBounds("2024-02");
  assert.equal(leap.days, 29);
  assert.equal(
    prorateForMonth({ monthlyAmount: "290", prorationBasis: "daily", coveredFrom: "2024-02-01", coveredTo: "2024-02-29", month: leap }),
    "290.0000",
  );
  const empty = refused(() =>
    prorateForMonth({ monthlyAmount: "290", prorationBasis: "daily", coveredFrom: "2024-03-01", coveredTo: "2024-03-31", month: leap }),
  );
  assert.match(empty, /does not touch/);
  assert.match(empty, /nothing is owed/);
});

test("civil dates reject impossible days and cross year boundaries", () => {
  assert.equal(daysInMonth(2024, 2), 29);
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(addDaysCivil("2026-12-31", 1), "2027-01-01");
  assert.equal(addDaysCivil("2026-01-01", -1), "2025-12-31");
  const bad = refused(() => addDaysCivil("2026-02-30", 0));
  assert.match(bad, /has 28 days/);
  const month = refused(() => monthBounds("2026-13"));
  assert.match(month, /use YYYY-MM/);
});

test("overlap counts inclusive days and touch detects open-ended enrolments", () => {
  assert.equal(overlapDays("2026-01-01", "2026-01-31", "2026-01-15", "2026-02-15"), 17);
  assert.equal(overlapDays("2026-01-01", "2026-01-10", "2026-01-11", "2026-01-20"), 0);
  const jan = monthBounds("2026-01");
  assert.equal(enrollmentTouchesMonth("2025-06-01", null, jan), true);
  assert.equal(enrollmentTouchesMonth("2026-02-01", null, jan), false);
  assert.equal(enrollmentTouchesMonth("2026-01-15", "2026-01-20", jan), true);
  const inverted = refused(() => enrollmentTouchesMonth("2026-02-01", "2026-01-01", jan));
  assert.match(inverted, /on or after its start/);
});

test("waiting period names the first eligible date", () => {
  assert.equal(waitingEligibleDate("2026-01-10", 90), "2026-04-10");
  assert.equal(waitingEligibleDate("2026-01-10", 0), "2026-01-10");
  const bad = refused(() => waitingEligibleDate("2026-01-10", -1));
  assert.match(bad, /non-negative whole number/);
});

test("window overlap needs same kind, same scope, and shared days", () => {
  const base = { kind: "open_enrollment", opensOn: "2026-10-01", closesOn: "2026-10-31", employerSubsidiaryId: null, departmentId: null };
  assert.equal(windowsOverlap(base, { ...base }), true);
  assert.equal(windowsOverlap(base, { ...base, opensOn: "2026-11-01", closesOn: "2026-11-30" }), false);
  assert.equal(windowsOverlap(base, { ...base, kind: "new_hire" }), false);
  assert.equal(
    windowsOverlap(base, { ...base, employerSubsidiaryId: "11111111-1111-1111-1111-111111111111" }),
    false,
  );
  // Shared boundary day still overlaps.
  assert.equal(windowsOverlap(base, { ...base, opensOn: "2026-10-31", closesOn: "2026-11-30" }), true);
});
