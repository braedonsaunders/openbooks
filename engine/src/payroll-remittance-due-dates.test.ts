import assert from "node:assert/strict";
import test from "node:test";
import { remittanceDueDate, remittanceDueDateExplained } from "./payroll-remittance.ts";

/**
 * CRA remittance due dates, for every remitter type.
 *
 * Each case is hand-worked from the CRA's published "When to remit (pay)"
 * table and its weekend/holiday sentence:
 *
 *   https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/
 *     payroll/remitting-source-deductions/how-when-remit-due-dates.html
 *   https://www.canada.ca/en/revenue-agency/services/tax/public-holidays.html
 *
 * The 2026 weekday anchors every case below leans on, taken from the CRA's own
 * published 2026 public-holiday list: New Year Thu Jan 1, Good Friday Apr 3,
 * Easter Monday Apr 6, Victoria Day Mon May 18, Saint-Jean Wed Jun 24 (Quebec
 * only), Canada Day Wed Jul 1, Civic Holiday Mon Aug 3 (everywhere but
 * Quebec), Labour Day Mon Sep 7, Truth and Reconciliation Wed Sep 30,
 * Thanksgiving Mon Oct 12, Remembrance Wed Nov 11, Christmas Fri Dec 25,
 * Boxing Day Sat Dec 26.
 *
 * A wrong date here is a 3–10% penalty on the remittance, so nothing is
 * inferred from the implementation.
 */

test("regular remitter: the 15th of the following month", () => {
  // August 2026's 15th is a Saturday, so the deadline is the Monday.
  assert.equal(remittanceDueDate("2026-07-31", "regular"), "2026-08-17");
  // September 15 2026 is a Tuesday and does not move.
  assert.equal(remittanceDueDate("2026-08-31", "regular"), "2026-09-15");
  // Across the year boundary.
  assert.equal(remittanceDueDate("2026-12-31", "regular"), "2027-01-15");
});

test("no filing account is the CRA's default registration: a regular remitter", () => {
  assert.equal(remittanceDueDate("2026-08-31", null), "2026-09-15");
});

test("quarterly remitter: the 15th after the quarter, not after the period", () => {
  // "January 1 to March 31 … April 15" — a period ending anywhere in Q1 is
  // due April 15, which is a Wednesday in 2026.
  assert.equal(remittanceDueDate("2026-03-31", "quarterly"), "2026-04-15");
  assert.equal(remittanceDueDate("2026-01-31", "quarterly"), "2026-04-15");
  assert.equal(remittanceDueDate("2026-02-28", "quarterly"), "2026-04-15");
  // The other three quarters.
  assert.equal(remittanceDueDate("2026-06-30", "quarterly"), "2026-07-15");
  assert.equal(remittanceDueDate("2026-09-30", "quarterly"), "2026-10-15");
  assert.equal(remittanceDueDate("2026-12-31", "quarterly"), "2027-01-15");
});

test("quarterly: a 15th on a weekend moves to the next business day", () => {
  // August 15 2026 is a Saturday; a Q3 2027 check for a different weekday.
  // October 15 2028 is a Sunday, so the deadline is Monday the 16th.
  assert.equal(remittanceDueDate("2028-09-30", "quarterly"), "2028-10-16");
});

test("accelerated threshold 1: the 25th, then the 10th", () => {
  // "1st to 15th of the month … 25th day of same month."
  // January 25 2026 is a Sunday, so it moves to Monday the 26th.
  assert.equal(remittanceDueDate("2026-01-15", "accelerated_1"), "2026-01-26");
  // May 25 2026 is a Monday — and Victoria Day that year is the 18th, so the
  // 25th is an ordinary business day.
  assert.equal(remittanceDueDate("2026-05-15", "accelerated_1"), "2026-05-25");
  // "16th to end of the month … 10th day of the next month."
  assert.equal(remittanceDueDate("2026-01-31", "accelerated_1"), "2026-02-10");
  // December's second half is due January 10 2027, a Sunday, so the 11th.
  assert.equal(remittanceDueDate("2026-12-31", "accelerated_1"), "2027-01-11");
});

test("accelerated threshold 2: the third WORKING day after each quarter-month", () => {
  // 1st–7th: January 7 2026 is a Wednesday. The 8th and 9th count, the
  // weekend does not, so the third working day is Monday the 12th.
  assert.equal(remittanceDueDate("2026-01-07", "accelerated_2"), "2026-01-12");
  // 15th–21st: July 21 2026 is a Tuesday; three clear working days is the 24th.
  assert.equal(remittanceDueDate("2026-07-21", "accelerated_2"), "2026-07-24");
  // 8th–14th: August 14 2026 is a Friday, so the count runs into the next week.
  assert.equal(remittanceDueDate("2026-08-14", "accelerated_2"), "2026-08-19");
});

test("accelerated threshold 2 counts THREE holidays out of one deadline", () => {
  // The 22nd-to-month-end period for March 2026 ends Tuesday March 31. April 1
  // and 2 count; Good Friday (April 3), the weekend and Easter Monday (April 6)
  // do not. The third working day is Tuesday April 7 — a full week later than
  // a naive "three calendar days" would say.
  assert.equal(remittanceDueDate("2026-03-31", "accelerated_2"), "2026-04-07");
  // Across the year: December 31 2026 is a Thursday, New Year's Day 2027 is a
  // Friday the CRA recognizes, so the count starts on Monday January 4.
  assert.equal(remittanceDueDate("2026-12-31", "accelerated_2"), "2027-01-06");
});

test("a period end inside a quarter-month is measured to that period's end", () => {
  // The deadline attaches to the CRA's period, not to whatever range an
  // operator happened to summarize: the 3rd, the 5th and the 7th all sit in
  // the 1st-to-7th period and share its deadline.
  for (const day of ["03", "05", "07"]) {
    assert.equal(remittanceDueDate(`2026-01-${day}`, "accelerated_2"), "2026-01-12");
  }
  for (const day of ["16", "20", "21"]) {
    assert.equal(remittanceDueDate(`2026-07-${day}`, "accelerated_2"), "2026-07-24");
  }
});

test("the CRA's Quebec calendar moves Quebec deadlines and only Quebec's", () => {
  // Saint-Jean-Baptiste Day, Wednesday June 24 2026, is recognized in Quebec
  // and nowhere else. The 15th-to-21st period ends Sunday June 21; three
  // working days is the 24th nationally and the 25th in Quebec.
  assert.equal(remittanceDueDate("2026-06-21", "accelerated_2"), "2026-06-24");
  assert.equal(remittanceDueDate("2026-06-21", "accelerated_2", { quebec: true }), "2026-06-25");
  // The Civic Holiday, Monday August 3 2026, runs the other way: recognized
  // everywhere EXCEPT Quebec. The July 22-to-31 period ends Friday July 31.
  assert.equal(remittanceDueDate("2026-07-31", "accelerated_2"), "2026-08-06");
  assert.equal(remittanceDueDate("2026-07-31", "accelerated_2", { quebec: true }), "2026-08-05");
});

test("every due date lands on a business day", () => {
  // The property the whole exercise exists for: no schedule, in any month of
  // any of three years, ever stamps a Saturday, a Sunday or a CRA holiday.
  const types = ["regular", "quarterly", "accelerated_1", "accelerated_2"] as const;
  for (const year of [2026, 2027, 2028]) {
    for (let month = 1; month <= 12; month += 1) {
      const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
      for (const day of ["07", "14", "21", end.slice(8, 10)]) {
        for (const remitter of types) {
          for (const quebec of [false, true]) {
            const due = remittanceDueDate(
              `${year}-${String(month).padStart(2, "0")}-${day}`, remitter, { quebec },
            );
            const weekday = new Date(`${due}T00:00:00Z`).getUTCDay();
            assert.notEqual(weekday, 0, `${due} (${remitter}) is a Sunday`);
            assert.notEqual(weekday, 6, `${due} (${remitter}) is a Saturday`);
            assert.ok(due > `${year}-${String(month).padStart(2, "0")}-${day}`,
              `${due} must follow the period it closes`);
          }
        }
      }
    }
  }
});

test("the rule that produced the date travels with it", () => {
  // An operator reviewing a remittance bill must be able to see WHY the date
  // is what it is — a stamped date nobody can explain is a date nobody checks.
  assert.match(
    remittanceDueDateExplained("2026-03-31", "accelerated_2").rule,
    /the 22nd to the last day of the month.*3rd working day/s,
  );
  assert.match(
    remittanceDueDateExplained("2026-01-15", "accelerated_1").rule,
    /the 1st to the 15th, due the 25th of the same month/,
  );
  assert.match(
    remittanceDueDateExplained("2026-06-30", "quarterly").rule,
    /15th of the month following the end of the quarter/,
  );
});
