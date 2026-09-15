import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const view = readFileSync(new URL("./view.ts", import.meta.url), "utf8");
const lib = readFileSync(new URL("../../api/timesheets/_lib.ts", import.meta.url), "utf8");

test("timesheets page carries the caller subsidiary scope into every employee/week read", () => {
  assert.match(
    view,
    /subsidiaryVisibleFilter\(sql`p\.subsidiary_id`, authz\.allowedSubsidiaryIds\)/,
    "the employee list must hide employees outside the caller's legal entities",
  );
  assert.match(
    view,
    /pinTimesheetEmployee\(orgId, myEmployee, authz\.allowedSubsidiaryIds\)/,
    "the new-timesheet fallback employee must be scope-pinned",
  );
  assert.match(
    view,
    /pinTimesheetEmployee\(orgId, requestedEmployeeId, authz\.allowedSubsidiaryIds\)/,
    "a URL-selected employee must be scope-pinned before loading the drawer",
  );
  assert.match(
    view,
    /loadPickers\(orgId, openEmployeeId, authz\.allowedSubsidiaryIds\)/,
    "drawer pickers must be loaded within the caller's subsidiary scope",
  );
  assert.match(
    view,
    /loadWeek\(orgId, openEmployeeId, openWeek, authz\.allowedSubsidiaryIds\)/,
    "drawer hours must be loaded within the caller's subsidiary scope",
  );
});

test("timesheet pickers constrain subsidiary-bearing projects and departments", () => {
  assert.match(lib, /export async function loadPickers\([\s\S]*allowedSubsidiaryIds/);
  assert.match(
    lib,
    /from projects p[\s\S]*subsidiaryVisibleFilter\(sql`p\.subsidiary_id`, allowedSubsidiaryIds \?\? null\)/,
  );
  assert.match(
    lib,
    /from departments d[\s\S]*subsidiaryVisibleFilter\(sql`d\.subsidiary_id`, allowedSubsidiaryIds \?\? null, \{ orgWideNull: true \}\)/,
  );
});
