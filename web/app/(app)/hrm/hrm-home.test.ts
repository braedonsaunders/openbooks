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
const widgets = readFileSync(new URL("../../../components/viewspec/widgets.tsx", import.meta.url), "utf8");
const contracts = readFileSync(new URL("../../../components/viewspec/widget-contracts.ts", import.meta.url), "utf8");
const names = readFileSync(new URL("../../../components/viewspec/registry-names.ts", import.meta.url), "utf8");
const groupTabs = readFileSync(new URL("../../../components/module-home/group-tabs.ts", import.meta.url), "utf8");
const navRegistry = readFileSync(
  new URL("../../../../engine/src/modules/nav-registry.ts", import.meta.url),
  "utf8",
);
const featureRegistry = readFileSync(
  new URL("../../../../engine/src/feature-registry.ts", import.meta.url),
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
  assert.match(loader, /businessToday/, "as-of today is the org business date, never new Date arithmetic");
  assert.ok(!/from worker_employments/.test(loader), "loader issues no direct employment table reads");
  assert.ok(!/from worker_employment_versions/.test(loader), "loader issues no direct version reads");
  assert.ok(!/from hrm_employment_change_requests/.test(loader), "loader issues no direct request reads");
});

test("headcount table carries its empty state and never invents copy", () => {
  assert.match(sections, /groups\.length === 0/, "zero headcount renders the resolved empty state");
  assert.match(sections, /unassigned/, "assignments without a department stay explicitly unattributed");
  assert.match(widgets, /'hrm-headcount-table'/, "widget renders the shared section, never a second copy");
  assert.match(contracts, /'hrm-headcount-table': \{ props: \[/, "widget contract pins the prop surface");
  assert.match(names, /'hrm-headcount-table'/, "widget name is registered");
});

test("hrm route tabs keep the native employee list as the sibling tab", () => {
  assert.match(groupTabs, /hrm: \[/, "the HRM strip is defined once per nav group");
  assert.match(groupTabs, /href: '\/hrm'/, "strip lands on the cockpit");
  assert.match(groupTabs, /href: '\/entities\/employees'/, "strip lands on the native employee list, never a second roster");
  assert.match(groupTabs, /'\/hrm': 'hrm'/, "cockpit tab hides while the feature switch is off");
  assert.match(groupTabs, /hrmGroupTabs/, "permission exclusions stay at one call site");
});

test("hrm is registered as a default-off feature with its nav module", () => {
  assert.match(featureRegistry, /key: 'hrm', defaultEnabled: false/, "hrm defaults off on the Features switchboard");
  assert.match(navRegistry, /key: 'hrm',\n    href: '\/hrm'/, "nav module opens the cockpit");
  assert.match(navRegistry, /requiredPermission: 'hrm\.employment\.read'/, "nav module carries the read boundary");
  assert.match(navRegistry, /featureKey: 'hrm'/, "nav module hides while the feature is off");
  assert.ok(navStrings.includes('"hrm": "Human Resources"'), "sidebar label resolves from the catalog");
});

test("cockpit copy resolves from the hrm catalog, never inline English", () => {
  for (const key of [
    "home.title",
    "home.vitals.headcount",
    "home.groups.title",
    "home.groups.unassigned",
    "home.groups.empty",
    "home.directory.title",
  ]) {
    assert.ok(strings.includes(`"${key.split(".").pop()}"`), `en/hrm carries ${key}`);
  }
  assert.match(view, /f\('title'\)/, "spec titles resolve through view refs, never literals");
});
