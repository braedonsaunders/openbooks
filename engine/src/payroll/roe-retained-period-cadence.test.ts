import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { retainedPayPeriodProblem } from "./retained-period-calendar.ts";
import { validateRoePriorPeriod, type RoePriorPeriodInput } from "./roe-history.ts";
import {
  assembleRoeReportingWindow,
  type RoeWindowContext,
  type RoeCalendarPeriod,
  type RoeWindowStub,
} from "./roe-reporting-window.ts";
const source: RoePriorPeriodInput = {
  sourceFileId: randomUUID(),
  sourceVersionId: randomUUID(),
  sourceSha256: "a".repeat(64),
  sourceReference: "Original monthly register",
  insuranceReference: "Insured wages declaration",
  hoursReference: "Paid hours declaration",
  reason: "Qualify original reporting dates",
  expectedId: null,
  expectedUpdatedAt: null,
  filingAccountId: randomUUID(),
  payScheduleId: randomUUID(),
  frequency: "monthly",
  periodStart: "2026-01-21",
  periodEnd: "2026-02-20",
  payDate: "2026-02-25",
  earnedFrom: "2026-01-21",
  earnedTo: "2026-02-20",
  insurableEarnings: "100.01",
  insurableHours: "4.25",
  nilPeriod: false,
};
test("historical import refuses daily monthly and incomplete semi-monthly positions including nil periods", () => {
  for (const frequency of ["monthly", "semi_monthly"] as const) {
    assert.throws(
      () =>
        validateRoePriorPeriod({
          ...source,
          frequency,
          periodStart: "2026-02-20",
          periodEnd: "2026-02-20",
        }),
      /complete calendar-based/,
    );
    assert.throws(
      () =>
        validateRoePriorPeriod({
          ...source,
          frequency,
          periodStart: "2026-02-20",
          periodEnd: "2026-02-20",
          nilPeriod: true,
          payDate: null,
          earnedFrom: null,
          earnedTo: null,
          insurableEarnings: "0",
          insurableHours: "0",
        }),
      /complete calendar-based/,
    );
  }
});
test("monthly retained dates support non-month-end anchors and February clamping without rewriting dates", () => {
  for (const [periodStart, periodEnd] of [
    ["2026-01-21", "2026-02-20"],
    ["2026-02-21", "2026-03-20"],
    ["2026-02-01", "2026-02-28"],
    ["2024-02-01", "2024-02-29"],
    ["2026-01-31", "2026-02-28"],
    ["2026-03-01", "2026-03-30"],
  ] as const) {
    const input = {
      ...source,
      periodStart,
      periodEnd,
      earnedFrom: periodStart,
      earnedTo: periodEnd,
    };
    const before = JSON.stringify(input);
    const qualified = validateRoePriorPeriod(input);
    assert.equal(qualified.periodStart, periodStart);
    assert.equal(qualified.periodEnd, periodEnd);
    assert.equal(JSON.stringify(input), before);
  }
  assert.match(retainedPayPeriodProblem("monthly", "2026-02-01", "2026-03-01") ?? "", /complete/);
});
test("semi-monthly retained dates support cross-month fixed boundaries and February month end", () => {
  for (const [periodStart, periodEnd] of [
    ["2026-01-21", "2026-02-05"],
    ["2026-02-06", "2026-02-20"],
    ["2026-02-21", "2026-03-05"],
    ["2026-02-01", "2026-02-15"],
    ["2026-02-16", "2026-02-28"],
    ["2024-02-16", "2024-02-29"],
  ] as const) {
    assert.equal(retainedPayPeriodProblem("semi_monthly", periodStart, periodEnd), null);
    assert.equal(
      validateRoePriorPeriod({
        ...source,
        frequency: "semi_monthly",
        periodStart,
        periodEnd,
        earnedFrom: periodStart,
        earnedTo: periodEnd,
      }).periodEnd,
      periodEnd,
    );
  }
  assert.match(
    retainedPayPeriodProblem("semi_monthly", "2026-02-01", "2026-02-14") ?? "",
    /complete/,
  );
});
function window(frequency: string, spans: readonly (readonly [string, string])[]) {
  const ctx: RoeWindowContext = {
    orgId: "org",
    employeeId: "employee",
    name: "Worker",
    employmentId: "employment",
    subsidiaryId: "employer",
    scheduleId: "schedule",
    frequency,
    filingAccountId: "filing",
    event: {
      id: "event",
      employment_id: "employment",
      subsidiary_id: "employer",
      first_day_worked: spans[0]![0],
      last_insurable_earnings_on: spans.at(-1)![1],
      interruption_on: spans.at(-1)![1],
      salary_continuance_end_on: null,
      source_reference: "Original employment spell",
    },
  };
  const calendar: RoeCalendarPeriod[] = spans.map(([periodStart, periodEnd], i) => ({
    periodStart,
    periodEnd,
    payDate: periodEnd,
    documentId: "run-" + i,
    runType: "regular",
    explicitlyExcluded: false,
  }));
  const stubs: RoeWindowStub[] = calendar.map((p, i) => ({
    ...p,
    id: "stub-" + i,
    documentId: p.documentId!,
    subsidiaryId: "employer",
    employmentId: "employment",
    filingAccountId: "filing",
    currency: "CAD",
    payDate: p.periodEnd,
    insurableEarnings: "100.01",
    insurableHours: "4.25",
    hoursBasisQualified: true,
    earnedFrom: p.periodStart,
    earnedTo: p.periodEnd,
    earnedDatesComplete: true,
  }));
  return { ctx, calendar, stubs };
}
test("reporting read refuses thirteen contiguous daily monthly positions before they can satisfy counts", () => {
  const spans = Array.from({ length: 13 }, (_, i) => {
    const day = "2026-01-" + String(i + 1).padStart(2, "0");
    return [day, day] as const;
  });
  const f = window("monthly", spans);
  const before = JSON.stringify(f);
  assert.throws(
    () => assembleRoeReportingWindow(f.ctx, f.calendar, f.stubs),
    /complete calendar-based/,
  );
  assert.equal(JSON.stringify(f), before);
});
test("reporting read preserves original non-EOM and semi-monthly boundaries and exact earnings/hours", () => {
  for (const [frequency, spans] of [
    [
      "monthly",
      [
        ["2026-01-21", "2026-02-20"],
        ["2026-02-21", "2026-03-20"],
      ],
    ],
    [
      "semi_monthly",
      [
        ["2026-01-21", "2026-02-05"],
        ["2026-02-06", "2026-02-20"],
      ],
    ],
  ] as const) {
    const f = window(frequency, spans);
    const before = JSON.stringify(f);
    const result = assembleRoeReportingWindow(f.ctx, f.calendar, f.stubs);
    assert.equal(result.periods.length, 2);
    assert.equal(result.totalInsurableEarnings, "200.0200");
    assert.equal(result.totalInsurableHours, "8.5000");
    assert.equal(result.periods[0]!.periodEnd, spans[1][1]);
    assert.equal(JSON.stringify(f), before);
  }
});
