import assert from "node:assert/strict";
import test from "node:test";
import {
  TIMESHEET_WEEK_SUBJECT_KIND,
  resolveTimesheetWeek,
  timesheetWeekSubjectProfile,
  timesheetWeeksFlowAdapter,
} from "./timesheet-weeks-adapter.ts";
import { getFlowAdapter, listFlowSubjectProfiles } from "./registry.ts";

const EMPLOYEE = "b8cbe9f8-cc47-4291-8431-565540477c6e";
const WEEK_ID = "01a01d40-a070-7faa-b9b3-37444cd75385";

test("timesheet weeks are an authorable Flows subject with no hardcoded approver", () => {
  const profile = listFlowSubjectProfiles().find(
    (candidate) => candidate.subjectKind === TIMESHEET_WEEK_SUBJECT_KIND,
  );
  assert.equal(profile, timesheetWeekSubjectProfile);
  assert.deepEqual(profile?.triggers, ["on_submit"]);
  // Who approves is authored per tenant, never baked into the profile.
  assert.equal(Object.prototype.hasOwnProperty.call(profile ?? {}, "approver"), false);
  for (const key of ["employeeId", "weekStart", "totalHours", "billableHours", "overtimeHours"]) {
    assert.equal(profile?.fields.some((f) => f.key === key), true, key);
  }
});

test("the registry resolves the timesheet adapter by subject kind", () => {
  assert.equal(getFlowAdapter(TIMESHEET_WEEK_SUBJECT_KIND), timesheetWeeksFlowAdapter);
});

test("a non-uuid subject id resolves to null without touching the database", async () => {
  // The composite `employee:week` the list URL uses is NOT a subject id; flow
  // subjects are the header row's uuid, like every other subject kind.
  for (const bad of ["", "no-separator", `${EMPLOYEE}:2026-03-29`, "not-a-uuid"]) {
    assert.equal(await resolveTimesheetWeek(bad), null, bad);
  }
});

test("the deep link opens the week's flyout", () => {
  assert.equal(
    timesheetWeeksFlowAdapter.deepLink(WEEK_ID),
    `/timesheets?timesheet=${WEEK_ID}`,
  );
});

test("the label names the person and the week", () => {
  assert.equal(
    timesheetWeeksFlowAdapter.label(WEEK_ID, {
      employeeName: "Dwayne Ellis",
      weekStart: "2026-03-29",
    }),
    "Dwayne Ellis — week of 2026-03-29",
  );
});

test("hours are not writable by a flow, and status is engine-released", async () => {
  // A flow must not rewrite the hours it is approving, nor jump the lifecycle
  // past the gate resolution that decideGate owns.
  assert.equal(timesheetWeeksFlowAdapter.writableFields.size, 0);
  await assert.rejects(
    () => timesheetWeeksFlowAdapter.setField("x", "totalHours", 1, { orgId: "o" }),
    /not writable/,
  );
  await assert.rejects(
    () => timesheetWeeksFlowAdapter.changeStatus("x", "approved", { orgId: "o" }),
    /approval engine/,
  );
});

test("an unparseable subject id loads no context instead of throwing", async () => {
  assert.equal(await timesheetWeeksFlowAdapter.loadContext("garbage"), null);
  assert.equal(await timesheetWeeksFlowAdapter.getStatus("garbage"), null);
});
