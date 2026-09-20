import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Native composition contract for the department headcount board
// (/hrm/departments). Runs without dependencies: it reads the maintained
// sources and proves the board resolves through the canonical headcount
// service, reuses the shared headcount table and directory section (never
// a second table), and states the drill-through limit honestly — gated on
// the hrm feature switch plus hrm.employment.read.
const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const view = readFileSync(new URL("./view.ts", import.meta.url), "utf8");
const loader = readFileSync(new URL("../../../../lib/hrm/departments.ts", import.meta.url), "utf8");
const strings = readFileSync(new URL("../../../../messages/en/hrm.json", import.meta.url), "utf8");

test("board renders through ModuleView with a loader-owned spec", () => {
  assert.match(page, /<ModuleView/, "page renders through the shared ModuleView host");
  assert.match(page, /loadHrmDepartmentsPage/, "page loads through the departments loader");
  assert.match(view, /hrmDepartmentsSpec/, "view exposes the spec builder");
  assert.match(view, /module-home-tabs/, "header carries the route-tab strip");
  assert.match(view, /hrm-headcount-table/, "numbers render through the shared headcount widget");
  assert.match(view, /directory-section/, "working links reuse the shared directory section");
});

test("board gates on the hrm feature switch plus the employment read grant", () => {
  assert.match(view, /requirePermission\('hrm\.employment\.read'\)/, "page requires the employment read grant");
  assert.match(view, /isFeatureEnabled\(authz\.user\.orgId, 'hrm'\)/, "page checks the Company Settings Features switch");
  assert.match(view, /notFound\(\)/, "a disabled switch 404s instead of rendering a gated board");
  assert.match(loader, /loadHrmDepartments\(authz: Authz\)/, "loader takes the authorized session, never re-gates");
});

test("every board figure comes from the canonical read service", () => {
  assert.match(loader, /getHeadcountAsOf/, "headcount resolves through the canonical read service");
  assert.match(loader, /businessToday/, "as-of today is the org business date, never new Date arithmetic");
  assert.ok(!/from worker_employments/.test(loader), "loader issues no direct employment table reads");
  assert.ok(!/from worker_employment_versions/.test(loader), "loader issues no direct version reads");
  assert.ok(!/from hrm_employment_change_requests/.test(loader), "loader issues no direct request reads");
  assert.match(loader, /unassigned/i, "assignments without a department stay explicitly unattributed");
});

test("drill-through and Setup management are explicit, never faked", () => {
  assert.match(loader, /\/entities\/employees/, "the board links the native employees list");
  assert.match(loader, /no department quick filter|no department filter/i, "the list limit is stated where the link is built");
  assert.match(loader, /\/admin\/setup\/departments/, "the board links where departments are managed in Setup");
  assert.match(view, /f\('listNote'\)/, "the drill-through limit renders as a panel hint");
});

test("board copy resolves from the hrm catalog, never inline English", () => {
  for (const key of [
    "title",
    "description",
    "listTitle",
    "listNote",
    "linksTitle",
    "employeesLink",
    "setupLink",
  ]) {
    assert.ok(strings.includes(`"${key}"`), `en/hrm carries departments.${key}`);
  }
  assert.match(view, /f\('title'\)/, "spec titles resolve through view refs, never literals");
});
