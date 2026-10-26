import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { validateRoeSubsequentService } from "./roe-subsequent-service.ts";
import {
  assembleRoeReportingWindow,
  type RoeWindowContext,
  type RoeWindowStub,
} from "../roe-reporting-window.ts";
const input = () => ({
  precedingEventId: randomUUID(),
  firstDayWorked: "2026-07-19",
  sourceFileId: randomUUID(),
  sourceVersionId: randomUUID(),
  sourceSha256: "a".repeat(64),
  sourceReference: " Original returned-work declaration ",
  reason: " Retain service reporting evidence ",
  expectedId: null,
  expectedUpdatedAt: null,
});
test("return evidence refuses invented calendar dates and unretained source identities", () => {
  assert.throws(
    () => validateRoeSubsequentService({ ...input(), firstDayWorked: "2026-02-30" }),
    /real calendar date/,
  );
  assert.throws(
    () => validateRoeSubsequentService({ ...input(), sourceSha256: "unqualified" }),
    /retained source/,
  );
  assert.throws(
    () => validateRoeSubsequentService({ ...input(), sourceReference: " " }),
    /original return-to-work source/,
  );
  assert.throws(
    () => validateRoeSubsequentService({ ...input(), expectedId: randomUUID() }),
    /Reload/,
  );
  const value = validateRoeSubsequentService(input());
  assert.equal(value.sourceReference, "Original returned-work declaration");
});

test("a scheduled period cannot extend the confirmed cutoff or merge earlier and returned service", () => {
  const context: RoeWindowContext = {
    orgId: "org",
    employeeId: "worker",
    name: "Worker",
    employmentId: "employment",
    subsidiaryId: "employer",
    scheduleId: "schedule",
    frequency: "biweekly",
    filingAccountId: "account",
    event: {
      id: "event",
      employment_id: "employment",
      subsidiary_id: "employer",
      first_day_worked: "2026-07-05",
      interruption_on: "2026-07-16",
      last_insurable_earnings_on: "2026-07-16",
      salary_continuance_end_on: null,
      source_reference: "Original event declaration",
    },
  };
  const calendar = [
    {
      periodStart: "2026-07-05",
      periodEnd: "2026-07-18",
      payDate: "2026-07-18",
      documentId: "run",
      runType: "regular" as const,
      explicitlyExcluded: false,
    },
  ];
  const stub: RoeWindowStub = {
    id: "stub",
    documentId: "run",
    subsidiaryId: "employer",
    employmentId: "employment",
    filingAccountId: "account",
    currency: "CAD",
    hoursBasisQualified: true,
    periodStart: "2026-07-05",
    periodEnd: "2026-07-18",
    payDate: "2026-07-18",
    insurableEarnings: "100.01",
    insurableHours: "4",
    earnedFrom: "2026-07-15",
    earnedTo: "2026-07-18",
    earnedDatesComplete: true,
  };
  assert.throws(
    () => assembleRoeReportingWindow(context, calendar, [stub]),
    /confirmed insurable or continuance cutoff/,
  );
  assert.throws(
    () =>
      assembleRoeReportingWindow(context, calendar, [
        { ...stub, earnedDatesComplete: false, earnedFrom: null, earnedTo: null },
      ]),
    /qualify the original service allocation/,
  );
  const allocated = assembleRoeReportingWindow(context, calendar, [
    { ...stub, earnedTo: "2026-07-16" },
  ]);
  assert.equal(allocated.totalInsurableEarnings, "100.0100");
  assert.equal(
    assembleRoeReportingWindow(
      {
        ...context,
        event: {
          ...context.event,
          salary_continuance_end_on: "2026-07-18",
          interruption_on: "2026-07-18",
        },
      },
      calendar,
      [stub],
    ).totalInsurableEarnings,
    "100.0100",
  );
});
