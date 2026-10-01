import assert from "node:assert/strict";
import test from "node:test";

// Behaviour contract for the HRM view strips: the registry filtered for a
// viewer, and the strip the page layout shows for a URL. Every page in a
// job must get the SAME strip with the right tab lit, a page outside every
// job gets none, and a viewer is never offered a tab they cannot open.
// Labels are the catalog keys, so the assertions pin routing, not copy.

const { hrmViewTabGroupsFor } = await import("./view-tab-registry.ts");
const { resolveViewTabs } = await import("../../components/module-home/view-tab-match.ts");

const EVERYTHING = (): boolean => true;
const key = (def: { key: string }): string => def.key;

function strip(url: string, groups = hrmViewTabGroupsFor(EVERYTHING, key)) {
  const parsed = new URL(url, "http://localhost");
  const tabs = resolveViewTabs(groups, parsed.pathname, parsed.searchParams);
  if (!tabs) return null;
  return {
    hrefs: tabs.map((tab) => tab.href),
    active: tabs.filter((tab) => tab.active).map((tab) => tab.label),
  };
}

test("every page in a job shows the job's one strip with its own tab lit", () => {
  const people = strip("/entities/employees");
  assert.deepEqual(people?.active, ["modules.employees"]);
  for (const url of ["/hrm/org-chart?view=directory", "/hrm/processes", "/hrm/documents", "/hrm/qualifications"]) {
    assert.deepEqual(strip(url)?.hrefs, people?.hrefs, `${url} shows the Employees strip`);
  }
  assert.deepEqual(strip("/hrm/processes/templates")?.active, ["processes.templates.title"], "templates select their own destination");

  const positions = strip("/hrm/positions?status=open");
  assert.deepEqual(positions?.active, ["home.tabs.positions"]);
  assert.deepEqual(strip("/hrm/recruiting")?.active, ["recruiting.tabs.openings"]);
  assert.deepEqual(strip("/hrm/recruiting?tab=interviews")?.active, ["recruiting.tabs.interviews"]);
  assert.deepEqual(strip("/hrm/recruiting?tab=retired")?.active, ["recruiting.tabs.openings"], "an unknown view falls back to the route");
  assert.deepEqual(strip("/hrm/performance?tab=calibration")?.active, ["performance.continuous.tabs.calibration"]);
  assert.deepEqual(strip("/hrm/surveys")?.active, ["home.tabs.surveys"]);
  assert.deepEqual(strip("/hrm/leave?view=calendar")?.active, ["leave.calendarTitle"]);
  assert.deepEqual(strip("/hrm/benefits?view=enrolments")?.active, ["benefits.workspace.tabs.enrollments"]);
  assert.deepEqual(strip("/hrm/compensation/cycles/c-1")?.active, ["home.tabs.compensation"]);
  assert.deepEqual(strip("/hrm/compensation/equity")?.active, ["equity.title"], "the longer route wins over the prefix");

  for (const url of ["/hrm", "/hrm/change-requests", "/hrm/compliance", "/hrm/my-leave", "/entities/vendors"]) {
    assert.equal(strip(url), null, `${url} belongs to no job and shows no strip`);
  }
});

test("filters carry between views of one route, never onto another route", () => {
  const hiring = strip("/hrm/recruiting?status=open&requisition=r-1");
  assert.deepEqual(hiring?.hrefs.slice(0, 3), [
    "/hrm/recruiting?status=open",
    "/hrm/positions",
    "/hrm/recruiting?tab=interviews&status=open",
  ]);
  assert.ok(!strip("/hrm/positions?status=open")?.hrefs.some((href) => href.includes("status")), "positions statuses are not recruiting statuses");
});

function forViewer(grants: string[], switches: string[]) {
  return hrmViewTabGroupsFor(
    (def) => (def.permissionsAny ? def.permissionsAny.some((permission) => grants.includes(permission)) : !def.permission || grants.includes(def.permission)) && (!def.feature || switches.includes(def.feature)),
    key,
  );
}

test("a viewer is offered only the tabs their grants and switches open", () => {
  const positionsOnly = forViewer(["hrm.position.read", "parties.read"], []);
  assert.equal(strip("/hrm/positions", positionsOnly), null, "one view is not a strip: no Openings without the recruiting grant");
  assert.equal(strip("/hrm/performance", positionsOnly), null, "Cycles alone is not a strip");

  const hiring = forViewer(["hrm.position.read", "hrm.recruiting.read"], ["hrmRecruiting"]);
  assert.deepEqual(strip("/hrm/positions", hiring)?.hrefs, [
    "/hrm/recruiting",
    "/hrm/positions",
    "/hrm/recruiting?tab=interviews",
    "/hrm/recruiting?tab=offers",
    "/hrm/recruiting?tab=postings",
    "/hrm/recruiting?tab=pools",
  ]);
  assert.equal(strip("/hrm/positions", forViewer(["hrm.position.read", "hrm.recruiting.read"], [])), null, "Recruiting off: no recruiting views");
});
