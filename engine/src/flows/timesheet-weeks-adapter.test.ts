import assert from "node:assert/strict";
import test from "node:test";
import {
  TIMESHEET_WEEK_SUBJECT_KIND,
  resolveTimesheetWeek,
  timesheetWeekSubjectProfile,
  timesheetWeeksFlowAdapter,
} from "./timesheet-weeks-adapter.ts";
import { getFlowAdapter, listFlowSubjectProfiles } from "./registry.ts";
import { db } from "../db.ts";

const EMPLOYEE = "b8cbe9f8-cc47-4291-8431-565540477c6e";
const WEEK_ID = "01a01d40-a070-7faa-b9b3-37444cd75385";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const DEPARTMENT_A = "22222222-2222-4222-8222-222222222222";
const DEPARTMENT_B = "33333333-3333-4333-8333-333333333333";

/** Reconstruct the literal SQL text from a drizzle query for test instrumentation. */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!Array.isArray(chunks)) return "";
  let out = "";
  for (const chunk of chunks) {
    if (
      chunk &&
      typeof chunk === "object" &&
      Array.isArray((chunk as { value?: unknown[] }).value)
    ) {
      out += ((chunk as { value: string[] }).value).join("");
    }
  }
  return out;
}

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

test("mixed-department weeks do not route under an arbitrary department", async (t) => {
  const queries: string[] = [];
  t.mock.method(db, "execute", async (query: unknown) => {
    queries.push(sqlText(query));
    if (queries.length === 1) {
      return {
        rows: [
          {
            org_id: ORG_ID,
            employee_name: "Dwayne Ellis",
            employee_party_id: EMPLOYEE,
            week_start: "2026-03-29",
            week_end: "2026-04-04",
            status: "submitted",
            total_hours: "16.0000",
            billable_hours: "16.0000",
            project_count: 2,
            entry_count: 2,
            // The guarded aggregate returns null when entries span A and B.
            department_id: null,
            submitted_by: null,
          },
        ],
      };
    }
    return {
      rows: [
        { workedOn: "2026-03-30", departmentId: DEPARTMENT_A },
        { workedOn: "2026-03-31", departmentId: DEPARTMENT_B },
      ],
    };
  });

  const context = await timesheetWeeksFlowAdapter.loadContext(WEEK_ID);
  assert.equal(context?.values.departmentId, null);
  assert.deepEqual(
    context?.rows.timeEntries.map((entry) => entry.departmentId),
    [DEPARTMENT_A, DEPARTMENT_B],
  );
  assert.match(
    queries[0] ?? "",
    /case\s+when\s+count\(distinct te\.department_id\)\s*=\s*1\s+then\s+min\(te\.department_id::text\)/i,
  );
});

test("a week with one department still exposes that department for routing", async (t) => {
  t.mock.method(db, "execute", async (query: unknown) => {
    if (sqlText(query).includes("case when count(distinct te.department_id)")) {
      return {
        rows: [
          {
            org_id: ORG_ID,
            employee_name: "Dwayne Ellis",
            employee_party_id: EMPLOYEE,
            week_start: "2026-03-29",
            week_end: "2026-04-04",
            status: "submitted",
            total_hours: "8.0000",
            billable_hours: "8.0000",
            project_count: 1,
            entry_count: 1,
            department_id: DEPARTMENT_A,
            submitted_by: null,
          },
        ],
      };
    }
    return { rows: [] };
  });

  const context = await timesheetWeeksFlowAdapter.loadContext(WEEK_ID);
  assert.equal(context?.values.departmentId, DEPARTMENT_A);
});
