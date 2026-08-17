import assert from "node:assert/strict";
import test from "node:test";
import {
  nextPeriodAfter,
  PayrollError,
  payPeriodsPerYearProblem,
  semiMonthlyAnchorProblem,
  semiMonthlyBoundaries,
} from "./payroll-run.ts";

/**
 * Period boundaries derived from `pay_schedules.anchor_period_end`.
 *
 * The case these exist for: `anchor_period_end` is `notNull` — a required field
 * the operator must answer — and the semi-monthly branch used to DISCARD it,
 * hardcoding the 15th and the month end. An employer paying the 5th and the
 * 20th saved without error and was then paid on days they did not choose, which
 * misaligns every pay date, the factor-P period the statutory engines annualize
 * with, and the period-overlap guard.
 *
 * Pure: no database, no money — just the calendar.
 */

/** Walk the schedule forward, `count` periods from `from`. */
function series(
  frequency: string, anchorPeriodEnd: string, from: string | null, count: number,
): { periodStart: string; periodEnd: string }[] {
  const out: { periodStart: string; periodEnd: string }[] = [];
  let cursor = from;
  for (let i = 0; i < count; i++) {
    const next = nextPeriodAfter({ frequency, anchor_period_end: anchorPeriodEnd }, cursor);
    out.push(next);
    cursor = next.periodEnd;
  }
  return out;
}

// --- 1. The anchor names the boundaries: a 5th/20th employer ----------------

test("a semi-monthly anchor on the 20th pays the 6th–20th and the 21st–5th", () => {
  const boundaries = semiMonthlyBoundaries("2026-01-20");
  assert.deepEqual(boundaries, { firstDay: 5, secondDay: 20 });

  // The anchor itself is the FIRST period this schedule produces.
  const first = nextPeriodAfter({ frequency: "semi_monthly", anchor_period_end: "2026-01-20" }, null);
  assert.deepEqual(first, { periodStart: "2026-01-06", periodEnd: "2026-01-20" });
});

test("a 5th/20th anchor derives 24 contiguous periods across a year, February included", () => {
  const periods = series("semi_monthly", "2026-01-20", "2026-01-20", 24);

  // Every period end lands on a day the employer chose — never the 15th or a
  // month end, which is what the hardcoded branch produced.
  for (const period of periods) {
    const day = Number(period.periodEnd.slice(8, 10));
    assert.ok(day === 5 || day === 20, `period ended ${period.periodEnd}`);
  }

  // February: the 21 January–5 February period spans the month boundary, and
  // the short month changes nothing — neither boundary is a month end.
  assert.deepEqual(periods.slice(0, 4), [
    { periodStart: "2026-01-21", periodEnd: "2026-02-05" },
    { periodStart: "2026-02-06", periodEnd: "2026-02-20" },
    { periodStart: "2026-02-21", periodEnd: "2026-03-05" },
    { periodStart: "2026-03-06", periodEnd: "2026-03-20" },
  ]);

  // Contiguous and gapless: each period starts the day after the last ended,
  // which is what keeps the overlap guard and the remittance period honest.
  const DAY = 24 * 60 * 60 * 1000;
  let previousEnd = "2026-01-20";
  for (const period of periods) {
    assert.equal(
      period.periodStart,
      new Date(new Date(`${previousEnd}T00:00:00Z`).getTime() + DAY).toISOString().slice(0, 10),
    );
    assert.ok(period.periodEnd > period.periodStart);
    previousEnd = period.periodEnd;
  }

  // 24 periods from 20 January 2026 reach 20 January 2027 — the factor-P
  // assumption (24 a year) holds because the boundaries, not a constant, say so.
  assert.equal(periods.at(-1)!.periodEnd, "2027-01-20");
});

test("the 5th and the 20th are one schedule: either anchor derives the same pair", () => {
  assert.deepEqual(semiMonthlyBoundaries("2026-03-05"), { firstDay: 5, secondDay: 20 });
  assert.deepEqual(semiMonthlyBoundaries("2026-03-20"), { firstDay: 5, secondDay: 20 });
  assert.deepEqual(
    series("semi_monthly", "2026-03-05", "2026-02-20", 3),
    series("semi_monthly", "2026-03-20", "2026-02-20", 3),
  );
});

// --- 2. Month-length edges: month end is a boundary KIND, not a day ---------

test("an anchor on the 31st means the 15th and the month end, and February follows", () => {
  assert.deepEqual(semiMonthlyBoundaries("2026-01-31"), { firstDay: 15, secondDay: "month_end" });

  // From no history the anchor is honoured as the first period end: 16–31
  // January, not 16–30.
  assert.deepEqual(
    nextPeriodAfter({ frequency: "semi_monthly", anchor_period_end: "2026-01-31" }, null),
    { periodStart: "2026-01-16", periodEnd: "2026-01-31" },
  );

  // Each month's second period runs to that month's own last day: 28 in a
  // common February, 30 in April, 31 in March.
  assert.deepEqual(series("semi_monthly", "2026-01-31", "2026-01-31", 6), [
    { periodStart: "2026-02-01", periodEnd: "2026-02-15" },
    { periodStart: "2026-02-16", periodEnd: "2026-02-28" },
    { periodStart: "2026-03-01", periodEnd: "2026-03-15" },
    { periodStart: "2026-03-16", periodEnd: "2026-03-31" },
    { periodStart: "2026-04-01", periodEnd: "2026-04-15" },
    { periodStart: "2026-04-16", periodEnd: "2026-04-30" },
  ]);
});

test("a leap February's 29th is a month end, and the next February is the 28th", () => {
  assert.deepEqual(semiMonthlyBoundaries("2028-02-29"), { firstDay: 15, secondDay: "month_end" });
  assert.deepEqual(series("semi_monthly", "2028-02-29", "2029-01-31", 2), [
    { periodStart: "2029-02-01", periodEnd: "2029-02-15" },
    { periodStart: "2029-02-16", periodEnd: "2029-02-28" },
  ]);
});

test("the classic 15th-and-month-end schedule is unchanged by the derivation", () => {
  // The behaviour every existing semi-monthly tenant has. An anchor on the
  // 15th, the 30th and the 31st all name it, because a boundary of 29/30/31 is
  // not a day every month has and can only mean the month end.
  for (const anchor of ["2026-01-15", "2026-04-30", "2026-01-31", "2026-01-30"]) {
    assert.deepEqual(
      semiMonthlyBoundaries(anchor),
      { firstDay: 15, secondDay: "month_end" },
      anchor,
    );
  }
  assert.deepEqual(series("semi_monthly", "2026-01-15", null, 4), [
    { periodStart: "2026-01-01", periodEnd: "2026-01-15" },
    { periodStart: "2026-01-16", periodEnd: "2026-01-31" },
    { periodStart: "2026-02-01", periodEnd: "2026-02-15" },
    { periodStart: "2026-02-16", periodEnd: "2026-02-28" },
  ]);
});

test("a 13th/28th anchor keeps fixed days in every month, February included", () => {
  // The last pair whose second boundary still exists in a common February.
  assert.deepEqual(semiMonthlyBoundaries("2026-01-28"), { firstDay: 13, secondDay: 28 });
  assert.deepEqual(series("semi_monthly", "2026-01-28", "2026-01-28", 3), [
    { periodStart: "2026-01-29", periodEnd: "2026-02-13" },
    { periodStart: "2026-02-14", periodEnd: "2026-02-28" },
    { periodStart: "2026-03-01", periodEnd: "2026-03-13" },
  ]);
});

test("a 1st/16th anchor is a schedule, not an error", () => {
  assert.deepEqual(semiMonthlyBoundaries("2026-06-16"), { firstDay: 1, secondDay: 16 });
  assert.deepEqual(series("semi_monthly", "2026-06-16", "2026-06-16", 2), [
    { periodStart: "2026-06-17", periodEnd: "2026-07-01" },
    { periodStart: "2026-07-02", periodEnd: "2026-07-16" },
  ]);
});

// --- 3. The two anchor shapes that are REFUSED, not reinterpreted -----------

test("the 14th is refused: its complement is a day February does not always have", () => {
  const problem = semiMonthlyAnchorProblem("2026-01-14");
  assert.ok(problem, "the 14th must be refused");
  assert.match(problem!, /14th/);
  assert.match(problem!, /29th/);
  assert.match(problem!, /February/);
  assert.throws(() => semiMonthlyBoundaries("2026-01-14"), PayrollError);
  assert.throws(
    () => nextPeriodAfter({ frequency: "semi_monthly", anchor_period_end: "2026-01-14" }, null),
    PayrollError,
  );
});

test("the last day of a 28-day February is refused as ambiguous", () => {
  // 2026-02-28 is simultaneously "the 28th" (a day every month has, pairing
  // with the 13th) and "the month end" (pairing with the 15th). Two different
  // calendars, so the anchor does not determine one.
  const problem = semiMonthlyAnchorProblem("2026-02-28");
  assert.ok(problem, "February's last day must be refused");
  assert.match(problem!, /February/);
  assert.match(problem!, /28th/);
  assert.match(problem!, /15th/);
  assert.throws(() => semiMonthlyBoundaries("2026-02-28"), PayrollError);

  // The same day-of-month in a longer month is NOT ambiguous, and is accepted.
  assert.equal(semiMonthlyAnchorProblem("2026-01-28"), null);
  // Nor is a leap February's last day, whose only coherent reading is the
  // month end.
  assert.equal(semiMonthlyAnchorProblem("2028-02-29"), null);
});

test("every other day of the month derives a schedule", () => {
  // The refusal set is exactly two shapes, stated as a closed enumeration so a
  // later change cannot quietly widen it.
  const refused: string[] = [];
  for (const month of ["2026-01", "2026-02", "2026-04", "2028-02"]) {
    const length = new Date(Date.UTC(
      Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0,
    )).getUTCDate();
    for (let day = 1; day <= length; day++) {
      const anchor = `${month}-${String(day).padStart(2, "0")}`;
      if (semiMonthlyAnchorProblem(anchor)) refused.push(anchor);
      else semiMonthlyBoundaries(anchor); // must not throw
    }
  }
  assert.deepEqual(refused, [
    "2026-01-14", "2026-02-14", "2026-02-28", "2026-04-14", "2028-02-14",
  ]);
});

test("a non-date anchor is refused rather than producing an Invalid Date period", () => {
  assert.ok(semiMonthlyAnchorProblem("not-a-date"));
  assert.match(semiMonthlyAnchorProblem("not-a-date")!, /not a date/);
});

// --- 4. The other frequencies are untouched --------------------------------

test("weekly, biweekly and monthly still derive from their own anchors", () => {
  assert.deepEqual(
    nextPeriodAfter({ frequency: "weekly", anchor_period_end: "2026-01-03" }, null),
    { periodStart: "2025-12-28", periodEnd: "2026-01-03" },
  );
  assert.deepEqual(
    nextPeriodAfter({ frequency: "biweekly", anchor_period_end: "2026-07-11" }, "2026-07-11"),
    { periodStart: "2026-07-12", periodEnd: "2026-07-25" },
  );
  // Monthly clamps to the month end, which is where the semi-monthly rule's
  // "month end is a kind" treatment comes from.
  assert.deepEqual(
    nextPeriodAfter({ frequency: "monthly", anchor_period_end: "2026-01-31" }, "2026-01-31"),
    { periodStart: "2026-02-01", periodEnd: "2026-02-28" },
  );
});

// --- 5. Factor P has to match the calendar the schedule describes ----------

/**
 * The defect one field over from the anchor: `periods_per_year` is what the
 * statutory engines annualize with, and the table's CHECK only constrains it to
 * the union of every frequency's legal counts. A semi-monthly schedule saved
 * with 26 therefore pays 24 times a year and withholds as though it paid 26.
 */

test("each frequency accepts exactly the period counts its calendar can produce", () => {
  for (const [frequency, legal] of Object.entries({
    weekly: [52, 53], biweekly: [26, 27], semi_monthly: [24], monthly: [12],
  })) {
    for (const count of legal) {
      assert.equal(payPeriodsPerYearProblem(frequency, count), null,
        `${frequency} must accept ${count}`);
    }
  }
});

test("a semi-monthly schedule cannot claim a biweekly year", () => {
  const problem = payPeriodsPerYearProblem("semi_monthly", 26);
  assert.ok(problem, "26 periods on a semi-monthly calendar must be refused");
  // The refusal names both the count it got and the one the calendar produces,
  // so the operator can fix it without reading the payroll spec.
  assert.match(problem!, /semi-monthly/);
  assert.match(problem!, /24/);
  assert.match(problem!, /26/);
});

test("the long-year counts belong only to the frequencies that can have one", () => {
  // 53 Fridays and 27 biweekly paydays are real years; a month-defined calendar
  // has no long year, so 53 on a monthly schedule is always a mistake.
  assert.equal(payPeriodsPerYearProblem("weekly", 53), null);
  assert.equal(payPeriodsPerYearProblem("biweekly", 27), null);
  assert.ok(payPeriodsPerYearProblem("monthly", 13));
  assert.ok(payPeriodsPerYearProblem("semi_monthly", 25));
  assert.ok(payPeriodsPerYearProblem("weekly", 26), "weekly is not biweekly");
  assert.ok(payPeriodsPerYearProblem("biweekly", 52), "biweekly is not weekly");
});

test("an unrecognised frequency is left to the enum, not second-guessed here", () => {
  // Refusing it here would report the wrong problem: the frequency is what is
  // invalid, and the column enum is what says so.
  assert.equal(payPeriodsPerYearProblem("fortnightly", 26), null);
});
