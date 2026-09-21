import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const source = read("./tools-time.ts");

/**
 * Source contract for the time-tracking and field-ticket assistant tools:
 * timesheet reads mirror the timesheet routes (`time.read` + `timeTracking`),
 * project-time reads mirror the project time-entries route (`projects.read`
 * + the Projects parent gate), and ticket reads mirror the ticket routes
 * (`time.read` + `fieldTickets`). No time tool writes.
 */
test("time tools declare the right gates and features", () => {
  for (const [tool, perm, feature] of [
    ["get_timesheet_week", "time.read", 'feature: "timeTracking"'],
    ["search_timesheets", "time.read", 'feature: "timeTracking"'],
    ["project_time", "projects.read", 'feature: "projects"'],
    ["unbilled_time", "projects.read", 'feature: "projects"'],
    ["list_field_tickets", "time.read", 'feature: "fieldTickets"'],
    ["get_field_ticket", "time.read", 'feature: "fieldTickets"'],
    // HR-20 begin: own clock status is self-scoped (time.clock), the team
    // scope additionally requires time.read; crew batches read time.read.
    ["time_clock_status", "time.clock", 'feature: "fieldTime"'],
    ["crew_batches", "time.read", 'feature: "fieldTimeCrewEntry"'],
    // HR-20 end
  ] as const) {
    const start = source.indexOf(`name: "${tool}"`);
    assert.ok(start >= 0, `${tool} is registered`);
    const window = source.slice(start, start + 600);
    assert.ok(window.includes(`"${perm}"`), `${tool} gates on ${perm}`);
    assert.ok(window.includes(feature), `${tool} declares ${feature}`);
  }
  assert.doesNotMatch(source, /category: "write"/, "time tools are read-only");
});

test("time tools reuse the screen loaders with the route boundaries", () => {
  assert.match(source, /pinTimesheetEmployee\(authz\.user\.orgId, a\.employeePartyId, authz\.allowedSubsidiaryIds\)/);
  assert.match(source, /loadWeek\(authz\.user\.orgId, owned, weekStart\(a\.week\), authz\.allowedSubsidiaryIds\)/);
  assert.match(source, /loadProjectTimeEntryPage\(\{/);
  assert.match(source, /projectUnbilled\(authz\.user\.orgId, a\.projectId/);
  assert.match(source, /loadFieldTicket\(authz\.user\.orgId, a\.ticketId/);
  assert.match(source, /allowedSubsidiaryIds: authz\.allowedSubsidiaryIds/);
});

test("time tools fail closed with stable error codes", () => {
  assert.match(source, /timeTracking_feature_disabled/);
  assert.match(source, /fieldTickets_feature_disabled/);
  assert.match(source, /projects_feature_disabled/);
  assert.match(source, /employee_not_found/);
  assert.match(source, /project_not_found/);
  assert.match(source, /field_ticket_not_found/);
  // HR-20 begin
  assert.match(source, /fieldTime_feature_disabled/);
  assert.match(source, /fieldTimeCrewEntry_feature_disabled/);
  assert.match(source, /team clock status needs time\.read/);
  // HR-20 end
});

test("ticket detail withholds signature images and customer email", () => {
  assert.doesNotMatch(source, /\.image/);
  assert.doesNotMatch(source, /customerEmail/);
  assert.match(source, /Signature pad images never leave this tool/);
});

test("time tools are exported and registered for the playbook", () => {
  assert.match(source, /export const TIME_TOOLS: AssistantToolDef\[\]/);
  // HR-20 begin: field-time tools join the export list.
  assert.ok(source.includes("timeClockStatus,"));
  assert.ok(source.includes("crewBatches,"));
  // HR-20 end
  assert.ok(source.includes("getFieldTicket,"));
});
