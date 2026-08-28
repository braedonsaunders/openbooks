import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  adjacentScheduledDay,
  cyclePositionOn,
  daysPerCycle,
  describeWorkSchedule,
  hoursPerCycle,
  hoursVaryByDay,
  isScheduledOn,
  pickWorkSchedule,
  scheduledDaysPerWeek,
  scheduledHoursBetween,
  scheduledHoursOn,
  scheduledHoursPerWeek,
  WorkScheduleError,
  type ResolvedWorkSchedule,
  type WorkScheduleRow,
} from "./work-schedules.ts";
import { createScratchOrg, dropScratchOrgReporting } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Scheduled hours — the generic employment attribute.
 *
 * Everything here is pure: rows and dates in, hours out, no database. The point
 * of the model is that it answers "what would this person have worked on THIS
 * day", which a weekly-hours number cannot, so most of these cases are days a
 * weekly number would get wrong.
 */

// 2026-01-04 is a Sunday.
const SUNDAY = "2026-01-04";

const row = (over: Partial<WorkScheduleRow> = {}): WorkScheduleRow => ({
  id: over.id ?? "row",
  name: null,
  employeePartyId: null,
  jobTitle: null,
  tradeId: null,
  departmentId: null,
  subsidiaryId: null,
  pattern: "cycle",
  cycleDays: 7,
  cycleAnchor: SUNDAY,
  days: [],
  effectiveFrom: "2020-01-01",
  effectiveTo: null,
  isActive: true,
  ...over,
});

const weekdays = (hours: string) =>
  [1, 2, 3, 4, 5].map((dayIndex) => ({ dayIndex, hours }));

const resolve = (over: Partial<ResolvedWorkSchedule> = {}): ResolvedWorkSchedule => ({
  id: "s", name: null, scope: "employee", pattern: "cycle",
  cycleDays: 7, cycleAnchor: SUNDAY, days: weekdays("8"), effectiveFrom: "2020-01-01",
  ...over,
});

// ---------------------------------------------------------------------------
// Reading a pattern
// ---------------------------------------------------------------------------

test("a weekly cycle anchored on a Sunday indexes by weekday", () => {
  const schedule = resolve();
  // 2026-07-01 is a Wednesday, 2026-07-04 a Saturday.
  assert.equal(cyclePositionOn(schedule, "2026-07-01"), 3);
  assert.equal(scheduledHoursOn(schedule, "2026-07-01"), "8.0000");
  assert.equal(scheduledHoursOn(schedule, "2026-07-04"), "0.0000");
  assert.equal(isScheduledOn(schedule, "2026-07-01"), true);
  assert.equal(isScheduledOn(schedule, "2026-07-04"), false);
});

test("the pattern extends backwards from its anchor, without drifting", () => {
  const schedule = resolve();
  // Years before the anchor. 2019-05-20 is a Monday, 2019-05-19 a Sunday.
  assert.equal(scheduledHoursOn(schedule, "2019-05-20"), "8.0000");
  assert.equal(scheduledHoursOn(schedule, "2019-05-19"), "0.0000");
});

test("a compressed four-day week owes ten hours or nothing, never eight", () => {
  // Four ten-hour days, Monday to Thursday: 40 hours a week, and a holiday on
  // the Friday is worth nothing while one on the Tuesday is worth ten. A single
  // weekly-hours number divided by five would pay eight on both, which is the
  // whole reason the model is a pattern.
  const schedule = resolve({
    days: [1, 2, 3, 4].map((dayIndex) => ({ dayIndex, hours: "10" })),
  });
  assert.equal(scheduledHoursPerWeek(schedule), "40.0000");
  assert.equal(scheduledHoursOn(schedule, "2026-07-07"), "10.0000"); // Tuesday
  assert.equal(scheduledHoursOn(schedule, "2026-07-03"), "0.0000"); // Friday
  assert.equal(scheduledDaysPerWeek(schedule), "4.0000");
  assert.equal(hoursVaryByDay(schedule), false, "four equal days do not vary");
});

test("a nine-day fortnight needs a fourteen-day cycle to be expressible at all", () => {
  // Week one: Monday–Friday. Week two: Monday–Thursday, the Friday off.
  const days = [
    ...[1, 2, 3, 4, 5].map((dayIndex) => ({ dayIndex, hours: "8.8889" })),
    ...[8, 9, 10, 11].map((dayIndex) => ({ dayIndex, hours: "8.8889" })),
  ];
  const schedule = resolve({ cycleDays: 14, days });
  // 2026-01-09 is the first Friday after the anchor; 2026-01-16 the second.
  assert.equal(isScheduledOn(schedule, "2026-01-09"), true);
  assert.equal(isScheduledOn(schedule, "2026-01-16"), false);
  assert.equal(daysPerCycle(schedule), 9);
});

test("a four-on-four-off rotation deliberately does not line up with the week", () => {
  const schedule = resolve({
    cycleDays: 8,
    cycleAnchor: "2026-01-01",
    days: [0, 1, 2, 3].map((dayIndex) => ({ dayIndex, hours: "12" })),
  });
  assert.equal(isScheduledOn(schedule, "2026-01-01"), true);
  assert.equal(isScheduledOn(schedule, "2026-01-04"), true);
  assert.equal(isScheduledOn(schedule, "2026-01-05"), false);
  assert.equal(isScheduledOn(schedule, "2026-01-09"), true);
  // The same weekday is a working day in one cycle and not in the next — which
  // seven weekday columns could not have represented.
  // 2026-01-01 is a Thursday and a working day; the next four Thursdays are
  // all rest days, and the fifth works again.
  assert.equal(isScheduledOn(schedule, "2026-01-08"), false);
  assert.equal(isScheduledOn(schedule, "2026-01-15"), false);
  assert.equal(isScheduledOn(schedule, "2026-01-29"), false);
  assert.equal(isScheduledOn(schedule, "2026-02-05"), true);
  assert.equal(scheduledHoursPerWeek(schedule), "42.0000");
});

test("unequal hours across working days ARE varying hours", () => {
  const schedule = resolve({
    days: [
      { dayIndex: 1, hours: "10" }, { dayIndex: 2, hours: "10" },
      { dayIndex: 3, hours: "10" }, { dayIndex: 4, hours: "4" },
    ],
  });
  assert.equal(hoursVaryByDay(schedule), true);
  // …and the day is still knowable, for anything that wants it.
  assert.equal(scheduledHoursOn(schedule, "2026-07-02"), "4.0000"); // Thursday
});

test("a declared varying schedule has no day, no week and no position", () => {
  const schedule = resolve({ pattern: "varies", cycleDays: null, cycleAnchor: null, days: [] });
  assert.equal(scheduledHoursOn(schedule, "2026-07-01"), null);
  assert.equal(isScheduledOn(schedule, "2026-07-01"), null);
  assert.equal(hoursPerCycle(schedule), null);
  assert.equal(scheduledHoursPerWeek(schedule), null);
  assert.equal(hoursVaryByDay(schedule), true);
  assert.equal(adjacentScheduledDay(schedule, "2026-07-01", -1), null);
  assert.throws(() => cyclePositionOn(schedule, "2026-07-01"), WorkScheduleError);
  assert.equal(describeWorkSchedule(schedule), "hours vary — no regular schedule");
});

test("a cycle with no working days at all is varying, not a zero-hour day", () => {
  assert.equal(hoursVaryByDay(resolve({ days: [] })), true);
});

test("the shift either side of a date is a fact about the pattern, not attendance", () => {
  const schedule = resolve();
  // Canada Day 2026 is a Wednesday; either side is the Tuesday and Thursday.
  assert.equal(adjacentScheduledDay(schedule, "2026-07-01", -1), "2026-06-30");
  assert.equal(adjacentScheduledDay(schedule, "2026-07-01", 1), "2026-07-02");
  // A Monday holiday reaches back over the weekend to the Friday.
  assert.equal(adjacentScheduledDay(schedule, "2026-09-07", -1), "2026-09-04");
});

test("hours across a span sum the pattern, day by day", () => {
  const schedule = resolve();
  // A full fortnight of Monday–Friday eights.
  assert.equal(scheduledHoursBetween(schedule, "2026-07-05", "2026-07-18"), "80.0000");
  assert.equal(scheduledHoursBetween(schedule, "2026-07-04", "2026-07-05"), "0.0000");
  assert.equal(scheduledHoursBetween(schedule, "2026-07-05", "2026-07-04"), "0");
});

// ---------------------------------------------------------------------------
// Resolution — the ONE mechanism
// ---------------------------------------------------------------------------

const EMPLOYEE = {
  employeePartyId: "emp-1",
  jobTitle: "Carpenter",
  tradeId: "trade-1",
  departmentId: "dept-1",
  subsidiaryId: "sub-1",
};

test("nothing recorded resolves to null — which means UNKNOWN, not zero hours", () => {
  assert.equal(pickWorkSchedule([], EMPLOYEE, "2026-07-01"), null);
});

test("the most specific scope wins, exactly as wages and entitlement limits do", () => {
  const rows = [
    row({ id: "org", days: weekdays("7") }),
    row({ id: "sub", subsidiaryId: "sub-1", days: weekdays("7.5") }),
    row({ id: "dept", departmentId: "dept-1", days: weekdays("7.6") }),
    row({ id: "trade", tradeId: "trade-1", days: weekdays("7.7") }),
    row({ id: "title", jobTitle: "carpenter", days: weekdays("7.8") }),
    row({ id: "emp", employeePartyId: "emp-1", days: weekdays("8") }),
  ];
  assert.equal(pickWorkSchedule(rows, EMPLOYEE, "2026-07-01")!.id, "emp");
  assert.equal(pickWorkSchedule(rows.slice(0, 5), EMPLOYEE, "2026-07-01")!.id, "title");
  assert.equal(pickWorkSchedule(rows.slice(0, 4), EMPLOYEE, "2026-07-01")!.id, "trade");
  assert.equal(pickWorkSchedule(rows.slice(0, 3), EMPLOYEE, "2026-07-01")!.id, "dept");
  assert.equal(pickWorkSchedule(rows.slice(0, 2), EMPLOYEE, "2026-07-01")!.id, "sub");
  assert.equal(pickWorkSchedule(rows.slice(0, 1), EMPLOYEE, "2026-07-01")!.scope, "organization");
  // Job title matches case-insensitively, like labor_cost_rates.
  assert.equal(pickWorkSchedule(rows.slice(0, 5), EMPLOYEE, "2026-07-01")!.scope, "job_title");
});

test("a scope row belonging to somebody else never competes", () => {
  const rows = [
    row({ id: "org", days: weekdays("7") }),
    row({ id: "other", employeePartyId: "emp-2", days: weekdays("12") }),
    row({ id: "other-dept", departmentId: "dept-9", days: weekdays("11") }),
  ];
  assert.equal(pickWorkSchedule(rows, EMPLOYEE, "2026-07-01")!.id, "org");
});

test("the pattern in force is the one in force ON THE DATE, not today's", () => {
  // Full time until March, part time after. Holiday pay for a January holiday
  // must still resolve against the January pattern.
  const rows = [
    row({ id: "full", employeePartyId: "emp-1", effectiveFrom: "2025-01-01", days: weekdays("8") }),
    row({
      id: "part", employeePartyId: "emp-1", effectiveFrom: "2026-03-01",
      days: [{ dayIndex: 2, hours: "6" }, { dayIndex: 4, hours: "6" }],
    }),
  ];
  assert.equal(pickWorkSchedule(rows, EMPLOYEE, "2026-01-01")!.id, "full");
  assert.equal(pickWorkSchedule(rows, EMPLOYEE, "2026-02-28")!.id, "full");
  assert.equal(pickWorkSchedule(rows, EMPLOYEE, "2026-03-01")!.id, "part");
  assert.equal(pickWorkSchedule(rows, EMPLOYEE, "2027-12-31")!.id, "part");
  // Before either takes effect there is still no schedule — and no guess.
  assert.equal(pickWorkSchedule(rows, EMPLOYEE, "2024-06-01"), null);
});

test("an expired or inactive row stops competing without rewriting the past", () => {
  const rows = [
    row({ id: "org", days: weekdays("7") }),
    row({
      id: "emp", employeePartyId: "emp-1", days: weekdays("8"),
      effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30",
    }),
  ];
  assert.equal(pickWorkSchedule(rows, EMPLOYEE, "2026-06-30")!.id, "emp");
  assert.equal(pickWorkSchedule(rows, EMPLOYEE, "2026-07-01")!.id, "org");
  assert.equal(
    pickWorkSchedule([{ ...rows[1]!, effectiveTo: null, isActive: false }], EMPLOYEE, "2026-07-01"),
    null,
  );
});

test("within a scope the latest effective_from wins, whatever order rows arrive in", () => {
  const rows = [
    row({ id: "b", employeePartyId: "emp-1", effectiveFrom: "2026-05-01", days: weekdays("6") }),
    row({ id: "a", employeePartyId: "emp-1", effectiveFrom: "2026-01-01", days: weekdays("8") }),
  ];
  assert.equal(pickWorkSchedule(rows, EMPLOYEE, "2026-07-01")!.id, "b");
  assert.equal(pickWorkSchedule([...rows].reverse(), EMPLOYEE, "2026-07-01")!.id, "b");
});

test("the description an operator reads in a refusal", () => {
  assert.equal(describeWorkSchedule(resolve()), "40 hours over 5 days per week");
  assert.equal(
    describeWorkSchedule(resolve({ cycleDays: 8, days: [{ dayIndex: 0, hours: "12" }] })),
    "12 hours over 1 day per 8-day cycle",
  );
});

/**
 * Scope uniqueness is a storage invariant, not just a resolver convention.
 * The expression index folds NULL scope keys to sentinels and lower-cases job
 * titles, so direct writers cannot create two contradictory rows that the
 * resolver would have to choose between.
 */
test("work-schedule scope uniqueness folds nullable keys and title case", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const insert = async (name: string, scope: { jobTitle?: string | null } = {}, effectiveFrom = "2026-01-01") => {
      await db.execute(sql`
        insert into work_schedules
          (id, org_id, name, job_title, pattern, cycle_days, cycle_anchor, effective_from, is_active)
        values
          (${randomUUID()}, ${org.orgId}, ${name}, ${scope.jobTitle ?? null}, 'cycle', 7,
           '2026-01-04', ${effectiveFrom}, true)`);
    };
    const rejectDuplicate = async (work: () => Promise<unknown>) => {
      await assert.rejects(work, (error: unknown) => {
        let current: unknown = error;
        for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
          const candidate = current as { code?: string; constraint?: string; cause?: unknown };
          if (candidate.code === "23505" && candidate.constraint === "work_schedules_scope_from") return true;
          current = candidate.cause;
        }
        return false;
      });
    };

    // Organization defaults have every nullable scope key set to NULL. A
    // plain unique index admits both rows; the normalized expression index
    // rejects the second one at the storage boundary.
    await insert("Default A");
    await rejectDuplicate(() => insert("Default B"));

    // The same normalization applies to the case-insensitive job-title scope;
    // a different title remains a valid independent scope on that date.
    await insert("Carpenter A", { jobTitle: "Carpenter" });
    await rejectDuplicate(() => insert("Carpenter B", { jobTitle: "carpenter" }));
    await insert("Electrician", { jobTitle: "Electrician" });
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});
