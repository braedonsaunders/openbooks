import assert from "node:assert/strict";
import test from "node:test";
import type { ObservedHoliday } from "../payroll/holidays.ts";
import type { WorkScheduleRow } from "../payroll/work-schedules.ts";
import {
  assertPlannableCapacity,
  computeAvailabilityForWeek,
  type ComputeAvailabilityInput,
} from "./availability.ts";
import { ResourcingRefusal } from "./errors.ts";

const person = {
  employeePartyId: "employee-1",
  scheduleScope: { jobTitle: "Consultant", tradeId: null, departmentId: "practice-1", subsidiaryId: "entity-1" },
};

function schedule(overrides: Partial<WorkScheduleRow> = {}): WorkScheduleRow {
  return {
    id: "schedule-1",
    name: "Consultant week",
    employeePartyId: null,
    jobTitle: "Consultant",
    tradeId: null,
    departmentId: null,
    subsidiaryId: null,
    pattern: "cycle",
    cycleDays: 7,
    cycleAnchor: "2026-04-05",
    days: [
      { dayIndex: 0, hours: "0" },
      { dayIndex: 1, hours: "8" },
      { dayIndex: 2, hours: "8" },
      { dayIndex: 3, hours: "8" },
      { dayIndex: 4, hours: "8" },
      { dayIndex: 5, hours: "8" },
      { dayIndex: 6, hours: "0" },
    ],
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    isActive: true,
    ...overrides,
  };
}

function holiday(date: string): ObservedHoliday {
  return {
    jurisdiction: "US",
    key: "company-closure",
    name: "Company closure",
    statutoryDate: date,
    date,
    source: "company",
    elected: true,
    paid: false,
  };
}

function compute(overrides: Partial<ComputeAvailabilityInput> = {}) {
  return computeAvailabilityForWeek({
    ...person,
    weekStart: "2026-04-05",
    schedules: [],
    annualHours: 2080,
    holidays: { applied: false, jurisdiction: null, reason: "No payroll profile or subsidiary country identifies a holiday jurisdiction.", dates: [] },
    absences: [],
    ...overrides,
  });
}

test("job-title work schedule wins over the organization schedule and is cited", () => {
  const organization = schedule({ id: "organization", jobTitle: null, days: schedule().days.map((day) => ({ ...day, hours: day.hours === "0" ? "0" : "6" })) });
  const jobTitle = schedule({ id: "job-title" });
  const result = compute({ schedules: [organization, jobTitle] });

  assert.equal(result.capacity.hours, "40.0000");
  assert.deepEqual(result.capacity.tier, { tier: "schedule", scheduleId: "job-title", scope: "job_title" });
  assert.ok(result.capacity.scheduleSources.every((source) => source.scheduleId === "job-title" && source.scope === "job_title"));
});

test("absence of a schedule uses the labor-costing annual-hours standard", () => {
  const result = compute({ annualHours: 1950 });

  assert.equal(result.capacity.hours, "37.5000");
  assert.deepEqual(result.capacity.tier, { tier: "labor-costing-standard", annualHours: 1950 });
});

test("a varies schedule leaves capacity unknown and assignment refusal gives its remedy", () => {
  const result = compute({
    schedules: [schedule({
      pattern: "varies",
      cycleDays: null,
      cycleAnchor: null,
      days: [],
    })],
  });

  assert.equal(result.capacity.hours, null);
  assert.deepEqual(result.capacity.tier, { tier: "unknown", cause: "varies-schedule" });
  assert.throws(() => assertPlannableCapacity(result), (error: unknown) => {
    assert.ok(error instanceof ResourcingRefusal);
    assert.equal(error.status, 422);
    assert.equal(error.code, "capacity_unknown");
    assert.equal(error.remedy, "give this person a cycle schedule in Setup → Payroll → Work schedules");
    return true;
  });
});

test("six calendar days of leave and a Monday holiday reduce both touched weeks", () => {
  const leave = [
    ["leave-thu", "2026-04-09"],
    ["leave-fri", "2026-04-10"],
    ["leave-sat", "2026-04-11"],
    ["leave-sun", "2026-04-12"],
    ["leave-mon", "2026-04-13"],
    ["leave-tue", "2026-04-14"],
  ].map(([id, onDate]) => ({ id: id!, onDate: onDate!, hours: "8" }));
  const calendar = { applied: true, jurisdiction: "US", dates: [holiday("2026-04-13")] };
  const schedules = [schedule()];
  const firstWeek = compute({ schedules, absences: leave, holidays: calendar });
  const secondWeek = compute({ weekStart: "2026-04-12", schedules, absences: leave, holidays: calendar });

  assert.equal(firstWeek.timeOff.hours, "24.0000");
  assert.equal(firstWeek.netCapacity, "16.0000");
  assert.equal(secondWeek.timeOff.hours, "24.0000");
  assert.equal(secondWeek.holidays.hours, "8.0000");
  assert.equal(secondWeek.netCapacity, "8.0000");
  assert.deepEqual(secondWeek.timeOff.absenceRowIds, ["leave-sun", "leave-mon", "leave-tue"]);
});

test("time off beyond scheduled capacity floors net capacity and records overage", () => {
  const result = compute({
    schedules: [schedule()],
    absences: [{ id: "absence-1", onDate: "2026-04-06", hours: "48" }],
  });

  assert.equal(result.netCapacity, "0.0000");
  assert.equal(result.overage, true);
  assert.equal(result.timeOff.hours, "48.0000");
});
