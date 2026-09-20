import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Native composition contract for the HRM module home (/hrm). Runs without
// dependencies: it reads the maintained sources and proves the cockpit is
// the purchasing-cockpit archetype — ViewSpec composes the grid and the
// panels, the bodies stay shared section components — gated on the hrm
// feature switch plus hrm.employment.read, with every figure resolved
// through the canonical read service (never a direct table read from the
// web app) and every label from the hrm catalog.
const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const view = readFileSync(new URL("./view.ts", import.meta.url), "utf8");
const sections = readFileSync(new URL("./sections.tsx", import.meta.url), "utf8");
const loader = readFileSync(new URL("../../../lib/hrm/home.ts", import.meta.url), "utf8");
const widgets = readFileSync(new URL("../../../components/viewspec/widgets-home.tsx", import.meta.url), "utf8");
const hrmWidgets = readFileSync(new URL("../../../components/viewspec/widgets-hrm.tsx", import.meta.url), "utf8");
const contracts = readFileSync(new URL("../../../components/viewspec/widget-contracts.ts", import.meta.url), "utf8");
const names = readFileSync(new URL("../../../components/viewspec/registry-names.ts", import.meta.url), "utf8");
const groupTabs = readFileSync(new URL("../../../components/module-home/group-tabs.ts", import.meta.url), "utf8");
const navRegistry = readFileSync(
  new URL("../../../../engine/src/navigation/nav-registry.ts", import.meta.url),
  "utf8",
);
const featureRegistry = readFileSync(
  new URL("../../../../engine/src/organization/feature-registry.ts", import.meta.url),
  "utf8",
);
const strings = readFileSync(new URL("../../../messages/en/hrm.json", import.meta.url), "utf8");
const navStrings = readFileSync(new URL("../../../messages/en/nav.json", import.meta.url), "utf8");

test("cockpit renders through ModuleView with a loader-owned spec", () => {
  assert.match(page, /<ModuleView/, "page renders through the shared ModuleView host");
  assert.match(page, /loadHrmPage|loadHrmHome/, "page loads through the HRM home loader");
  assert.match(view, /hrmSpec/, "view exposes the spec builder");
  assert.match(view, /module-home-tabs/, "header carries the route-tab strip");
  assert.match(view, /statTile\(/, "vitals render as house stat tiles");
  assert.match(view, /hrm-headcount-table/, "headcount hero renders through the shared widget");
  assert.match(view, /directory-section/, "rail reuses the shared directory section, never a copy");
});

test("cockpit gates on the hrm feature switch plus the employment read grant", () => {
  assert.match(view, /requirePermission\('hrm\.employment\.read'\)/, "page requires the employment read grant");
  assert.match(view, /isFeatureEnabled\(authz\.user\.orgId, 'hrm'\)/, "page checks the Company Settings Features switch");
  assert.match(view, /notFound\(\)/, "a disabled switch 404s instead of rendering a gated cockpit");
  assert.match(loader, /loadHrmHome\(authz: Authz\)/, "loader takes the authorized session, never re-gates");
});

test("every cockpit figure comes from the canonical read service", () => {
  assert.match(loader, /getHeadcountAsOf/, "headcount resolves through the canonical read service");
  assert.match(loader, /listChangeRequests\(/, "the pending queue resolves through the change-request service");
  assert.match(loader, /businessToday/, "as-of today is the org business date, never new Date arithmetic");
  assert.ok(!/from hrm_employment_change_requests/.test(loader), "loader issues no direct request-table reads");
});

test("the loader's scoped display queries stay org-predicated and scope-filtered", () => {
  // Starts/ends, recent changes, and readiness have no engine service, so
  // one clearly-scoped query each is the contract — and the contract pins
  // the predicates that keep them honest.
  assert.match(loader, /from worker_employment_versions/, "starts and ends read the live versions");
  assert.match(loader, /recorded_until is null/, "the window reads recorded-live rows only");
  assert.match(loader, /from employment_changes/, "recent changes read the aggregate evidence");
  assert.match(loader, /from parties[\s\S]*?join employee_roles/, "readiness counts active employee parties");
  assert.match(loader, /not exists \([\s\S]*?from worker_employments/, "readiness counts parties with no employment row");
  const orgPredicates = loader.match(/org_id = \$\{orgId\}/g) ?? []
  assert.ok(orgPredicates.length >= 3, `every scoped leg carries the org predicate (found ${orgPredicates.length})`);
  assert.match(loader, /subsidiaryVisibleFilter/, "scoped legs filter the actor's subsidiary lens");
  assert.match(loader, /loadQueueLabels\(/, "name resolution reuses the queue's shared resolver, never a second join");
});

test("headcount table carries its empty state and never invents copy", () => {
  assert.match(sections, /groups\.length === 0/, "zero headcount renders the resolved empty state");
  assert.match(sections, /unassigned/, "assignments without a department stay explicitly unattributed");
  assert.match(widgets, /'hrm-headcount-table'/, "widget renders the shared section, never a second copy");
  assert.match(contracts, /'hrm-headcount-table': \{ props: \[/, "widget contract pins the prop surface");
  assert.match(names, /'hrm-headcount-table'/, "widget name is registered");
});

test("the cockpit keeps its hero and adds the workspace panels", () => {
  for (const widget of ['hrm-headcount-table', 'hrm-pending-requests', 'hrm-upcoming-changes', 'hrm-recent-changes', 'hrm-readiness', 'directory-section']) {
    assert.match(view, new RegExp(`'${widget}'`), `cockpit composes the ${widget} body`);
  }
  for (const widget of ['hrm-pending-requests', 'hrm-upcoming-changes', 'hrm-recent-changes', 'hrm-readiness']) {
    assert.match(hrmWidgets, new RegExp(`'${widget}'`), `${widget} renders the shared section, never a second copy`);
    assert.match(contracts, new RegExp(`'${widget}': \\{ props: \\[`), `${widget} contract pins the prop surface`);
    assert.match(names, new RegExp(`'${widget}'`), `${widget} name is registered`);
  }
  assert.match(view, /statTile\(\{\s*iconKey: 'clipboard-check'/, "the vitals strip carries the pending count");
});

test("quick actions stay permission-gated and the readiness panel links migration help", () => {
  assert.match(view, /widget\(\s*'new-role-party'/, "the header carries the house New button");
  assert.match(view, /f\('canCreateEmployee'\)/, "employee creation keeps the parties.manage ref");
  assert.match(loader, /\/hrm\/change-requests/, "propose change enters through the queue");
  assert.match(loader, /hrm\.employment\.manage/, "the propose entry keeps the manage grant");
  assert.match(loader, /\/docs\/employment-migration/, "readiness links the migration article");
  assert.ok(strings.includes("not yet migrated to employment records"), "readiness names the headcount exclusion in words");
  assert.ok(strings.includes("never list here"), "the upcoming panel states probation ends are not modeled");
});

test("vacancy rides the same cockpit through the shared vacancy widget", () => {
  assert.match(view, /hrm-vacancy-table/, "vacancy renders through the shared widget");
  assert.match(widgets, /'hrm-vacancy-table'/, "widget renders the shared section, never a second copy");
  assert.match(contracts, /'hrm-vacancy-table': \{ props: \[/, "widget contract pins the prop surface");
  assert.match(names, /'hrm-vacancy-table'/, "widget name is registered");
  assert.match(loader, /getVacancyAsOf/, "vacancy resolves through the canonical position read service");
  assert.ok(!/from positions[^_]/.test(loader), "loader issues no direct position table reads");
  assert.ok(!/from position_versions/.test(loader), "loader issues no direct version reads");
  assert.ok(!/from position_funding/.test(loader), "loader issues no direct funding reads");
});

test("hrm route tabs keep the native employee list as the sibling tab", () => {
  assert.match(groupTabs, /hrm: \[/, "the HRM strip is defined once per nav group");
  assert.match(groupTabs, /href: '\/hrm'/, "strip lands on the cockpit");
  assert.match(groupTabs, /href: '\/entities\/employees'/, "strip lands on the native employee list, never a second roster");
  assert.match(groupTabs, /'\/hrm': 'hrm'/, "cockpit tab hides while the feature switch is off");
  assert.match(groupTabs, /hrmGroupTabs/, "permission exclusions stay at one call site");
});

test("hrm route tabs cover the whole workspace, each behind its own gate", () => {
  for (const href of ['/hrm', '/entities/employees', '/hrm/change-requests', '/hrm/departments', '/hrm/reports']) {
    assert.match(groupTabs, new RegExp(`href: '${href.replace(/\//g, '\\/')}'`), `strip lands on ${href}`);
  }
  for (const href of ['/hrm/change-requests', '/hrm/departments', '/hrm/reports']) {
    assert.match(groupTabs, new RegExp(`'${href.replace(/\//g, '\\/')}': 'hrm'`), `${href} tab hides while the feature switch is off`);
  }
  assert.match(groupTabs, /'\/hrm\/change-requests': 'hrm\.employment\.read'/, "queue tab hides without the employment read grant");
  assert.match(groupTabs, /'\/hrm\/departments': 'hrm\.employment\.read'/, "departments tab hides without the employment read grant");
  assert.match(groupTabs, /'\/hrm\/reports': 'reports\.read'/, "reports tab hides without the reports grant");
});

test("hrm is registered as a default-off feature with its nav module", () => {
  assert.match(featureRegistry, /key: 'hrm', defaultEnabled: false/, "hrm defaults off on the Features switchboard");
  assert.match(navRegistry, /key: 'hrm',\n    href: '\/hrm'/, "nav module opens the cockpit");
  assert.match(navRegistry, /requiredPermission: 'hrm\.employment\.read'/, "nav module carries the read boundary");
  assert.match(navRegistry, /featureKey: 'hrm'/, "nav module hides while the feature is off");
  for (const key of ['hrm-change-requests', 'hrm-departments', 'hrm-reports']) {
    assert.match(navRegistry, new RegExp(`key: '${key}'`), `${key} is a nav module like banking-cash`);
  }
  assert.match(navRegistry, /key: 'hrm-reports',[\s\S]*?requiredPermission: 'reports\.read'/, "the reports surface carries the builder's grant");
  assert.ok(navStrings.includes('"hrm": "Human Resources"'), "sidebar label resolves from the catalog");
});

test("cockpit copy resolves from the hrm catalog, never inline English", () => {
  for (const key of [
    "home.title",
    "home.vitals.headcount",
    "home.vitals.openPositions",
    "home.vitals.unfundedFte",
    "home.groups.title",
    "home.groups.unassigned",
    "home.groups.empty",
    "home.vacancy.title",
    "home.vacancy.empty",
    "home.directory.title",
  ]) {
    assert.ok(strings.includes(`"${key.split(".").pop()}"`), `en/hrm carries ${key}`);
  }
  for (const key of [
    "pending",
    "upcoming",
    "recent",
    "changes",
    "readiness",
    "actions",
  ]) {
    assert.ok(strings.includes(`"${key}"`), `en/hrm carries overview.${key}`);
  }
  assert.match(view, /f\('title'\)/, "spec titles resolve through view refs, never literals");
});
