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
  assert.match(view, /table\(\{/, "headcount hero composes a table block, not a bespoke component");
  assert.match(view, /variant: 'app'/, "cockpit tables use the shared app primitives");
  assert.match(view, /f\('groups'\)/, "headcount hero binds the loader-resolved rows");
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

test("cockpit hero is a table block; the bespoke headcount table is gone with the departments page", () => {
  // The cockpit hero renders through the shared `table` block over
  // loader-resolved rows; the hand-rolled HrmHeadcountTable and its widget
  // left with the Departments page (departments live in Company setup).
  assert.match(view, /table\(\{/, "cockpit hero composes a table block");
  assert.match(view, /f\('groups'\)/, "hero binds the loader-resolved headcount rows");
  assert.match(view, /empty: \{ title: f\('groupsEmpty'\) \}/, "zero headcount renders the resolved empty state");
  assert.match(loader, /departmentLabel/, "department display resolves in the loader, never in render");
  assert.match(loader, /totalValue/, "the totals row resolves formatted strings in the loader");
  assert.match(loader, /unassigned/, "assignments without a department stay explicitly unattributed");
  assert.doesNotMatch(widgets, /'hrm-headcount-table'/, "no bespoke headcount widget remains");
  assert.doesNotMatch(contracts, /'hrm-headcount-table'/, "no contract for a widget nobody renders");
  assert.ok(!sections.includes('<table'), "no hand-rolled table remains in the cockpit sections");
});

test("the cockpit keeps its hero and adds the workspace panels", () => {
  for (const widget of ['hrm-pending-requests', 'hrm-upcoming-changes', 'hrm-recent-changes', 'attention-list', 'trend-chart', 'directory-section']) {
    assert.match(view, new RegExp(`'${widget}'`), `cockpit composes the ${widget} body`);
  }
  for (const widget of ['hrm-pending-requests', 'hrm-upcoming-changes', 'hrm-recent-changes']) {
    assert.match(hrmWidgets, new RegExp(`'${widget}'`), `${widget} renders the shared section, never a second copy`);
    assert.match(contracts, new RegExp(`'${widget}': \\{ props: \\[`), `${widget} contract pins the prop surface`);
    assert.match(names, new RegExp(`'${widget}'`), `${widget} name is registered`);
  }
  assert.match(view, /statTile\(\{\s*iconKey: 'clipboard-check'/, "the vitals strip carries the pending count");
});

test("quick actions stay permission-gated and the readiness panel links migration help", () => {
  assert.match(view, /widget\(\s*'hrm-new-menu'/, "the header carries the shared New dropdown");
  assert.match(view, /canCreateEmployee: data\.canCreateEmployee/, "employee creation keeps its loader-resolved grant");
  assert.match(view, /canCreateProcess: data\.canCreateProcess/, "process creation keeps its loader-resolved grant");
  assert.match(loader, /\/hrm\/change-requests/, "propose change enters through the queue");
  assert.match(loader, /hrm\.employment\.manage/, "the propose entry keeps the manage grant");
  assert.match(loader, /\/docs\/employment-migration/, "readiness links the migration article");
  assert.ok(strings.includes("not yet migrated to employment records"), "readiness names the headcount exclusion in words");
  assert.ok(strings.includes("never list here"), "the upcoming panel states probation ends are not modeled");
});

test("vacancy rides the cockpit as a shared table block", () => {
  assert.match(view, /table\(\{/, "vacancy renders through the shared table block");
  assert.match(view, /f\('positions\.groups'\)/, "vacancy binds the loader-resolved by-department rows");
  assert.match(view, /variant: 'app'/, "vacancy uses the shared app table primitives");
  assert.ok(!/'hrm-vacancy-table'/.test(view), "no vacancy widget remains in the spec");
  assert.ok(!/'hrm-vacancy-table'/.test(hrmWidgets), "vacancy widget is deleted, never dead code");
  assert.ok(!/'hrm-vacancy-table'/.test(contracts), "vacancy widget contract is gone");
  assert.ok(!/'hrm-vacancy-table'/.test(names), "vacancy widget name is unregistered");
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

test("hrm route tabs are the fourteen working surfaces, each behind its own gate", () => {
  for (const href of ['/hrm', '/entities/employees', '/hrm/positions', '/hrm/processes', '/hrm/leave', '/hrm/recruiting', '/hrm/performance', '/hrm/benefits', '/hrm/compliance', '/hrm/compensation', '/hrm/qualifications', '/hrm/documents', '/hrm/surveys', '/hrm/org-chart']) {
    assert.match(groupTabs, new RegExp(`href: '${href.replace(/\//g, '\\/')}'`), `strip lands on ${href}`);
  }
  // Demoted by review: the queue is reached from the cockpit and the employee
  // drawer, self-service leave is a quick action, departments are configured
  // in Company setup, and workforce reports live in the Reports module.
  for (const href of ['/hrm/change-requests', '/hrm/my-leave', '/hrm/departments', '/hrm/reports']) {
    assert.doesNotMatch(groupTabs, new RegExp(`href: '${href.replace(/\//g, '\\/')}'`), `${href} is not a tab`);
  }
  assert.match(groupTabs, /'\/hrm\/positions': 'hrm\.position\.read'/, "positions tab hides without the headcount-plan read grant");
  assert.match(groupTabs, /'\/hrm\/processes': 'hrm\.process\.read'/, "processes tab hides without the process read grant");
  assert.match(groupTabs, /'\/hrm\/leave': 'hrm\.leave\.read'/, "leave desk tab hides without the leave read grant");
  assert.match(groupTabs, /'\/hrm\/benefits': 'hrm\.benefits\.read'/, "benefits tab hides without the benefits read grant");
  // HR-13 begin: compliance tab hides without the construction read grant
  // and while the construction switch is off.
  assert.match(groupTabs, /'\/hrm\/compliance': 'hrm\.construction\.read'/, "compliance tab hides without the construction read grant");
  assert.match(groupTabs, /'\/hrm\/compliance': 'hrmConstructionCompliance'/, "compliance tab hides while the construction switch is off");
  // HR-13 end
  // HR-14 begin: qualifications tab hides without the certifications
  // read grant and while the certifications switch is off.
  assert.match(groupTabs, /href: '\/hrm\/qualifications'/, "strip lands on /hrm/qualifications");
  assert.match(groupTabs, /'\/hrm\/qualifications': 'hrm\.certifications\.read'/, "qualifications tab hides without the certifications read grant");
  assert.match(groupTabs, /'\/hrm\/qualifications': 'hrmCertifications'/, "qualifications tab hides while the feature switch is off");
  // HR-14 end
  // HR-19 begin: documents and surveys tabs hide without their read
  // grants and while their switches are off. The org chart carries no
  // permission entry by design (employment readers and self-service
  // alike; the page re-checks and 404s) but hides while its switch is
  // off.
  assert.match(groupTabs, /href: '\/hrm\/documents'/, "strip lands on /hrm/documents");
  assert.match(groupTabs, /href: '\/hrm\/surveys'/, "strip lands on /hrm/surveys");
  assert.match(groupTabs, /href: '\/hrm\/org-chart'/, "strip lands on /hrm/org-chart");
  assert.match(groupTabs, /'\/hrm\/documents': 'hrm\.documents\.read'/, "documents tab hides without the documents read grant");
  assert.match(groupTabs, /'\/hrm\/surveys': 'hrm\.surveys\.manage'/, "surveys tab hides without the surveys manage grant");
  assert.match(groupTabs, /'\/hrm\/documents': 'hrmDocuments'/, "documents tab hides while the feature switch is off");
  assert.match(groupTabs, /'\/hrm\/surveys': 'hrmSurveys'/, "surveys tab hides while the feature switch is off");
  assert.match(groupTabs, /'\/hrm\/org-chart': 'hrmOrgChart'/, "org-chart tab hides while the feature switch is off");
  // HR-19 end
  // HR-12 begin
  assert.match(groupTabs, /'\/hrm\/compensation': 'hrm\.compensation\.read'/, "compensation tab hides without the compensation read grant");
  assert.match(groupTabs, /'\/hrm\/compensation': 'hrmCompensation'/, "compensation tab hides while the feature switch is off");
  // HR-12 end
  assert.match(groupTabs, /'\/hrm\/recruiting': 'hrm\.recruiting\.read'/, "recruiting tab hides without the funnel read grant");
  assert.match(groupTabs, /'\/hrm\/recruiting': 'hrm'/, "recruiting tab hides while the feature switch is off");
  assert.match(groupTabs, /'\/entities\/employees': 'parties\.read'/, "employees tab hides without the parties grant");
  // The performance tab carries NO permission entry by design: it sits
  // behind hrm.performance.read OR the structural scope (a manager with
  // reports and no grant still gets the tab), and the page never
  // access-denies — the read service narrows every row instead.
  const tabPermission = groupTabs.match(/const HRM_TAB_PERMISSION[\s\S]*?\n\}/)?.[0] ?? '';
  assert.doesNotMatch(tabPermission, /hrm\/performance/, "performance tab never hides on a missing grant");
  assert.match(groupTabs, /'\/hrm\/performance': 'hrm'/, "performance tab hides while the feature switch is off");
});

test("the employees list carries the same HRM strip", () => {
  const employees = readFileSync(new URL("../entities/[role]/view.ts", import.meta.url), "utf8");
  assert.match(employees, /slug === 'employees' && canReadHrm[\s\S]*?hrmGroupTabs\(authz, '\/entities\/employees'\)/, "the native employee list renders the HRM strip when the workspace exists for the viewer");
});

test("hrm is registered as a default-off feature with ONE nav module", () => {
  assert.match(featureRegistry, /key: 'hrm', defaultEnabled: false/, "hrm defaults off on the Features switchboard");
  assert.match(featureRegistry, /navModules: \['hrm'\]/, "the feature owns exactly the cockpit module");
  assert.match(navRegistry, /key: 'hrm',\n    href: '\/hrm'/, "nav module opens the cockpit");
  assert.match(navRegistry, /requiredPermission: 'hrm\.employment\.read'/, "nav module carries the read boundary");
  assert.match(navRegistry, /featureKey: 'hrm'/, "nav module hides while the feature is off");
  // Working surfaces are tabs on the cockpit, not sidebar modules of their
  // own: a second Departments entry beside Company setup's and a second
  // Reports entry beside the Reports module were the confusion under review.
  for (const key of ['hrm-change-requests', 'hrm-departments', 'hrm-reports']) {
    assert.doesNotMatch(navRegistry, new RegExp(`key: '${key}'`), `${key} is not a nav module`);
  }
  assert.ok(navStrings.includes('"hrm": "Human Resources"'), "sidebar label resolves from the catalog");
});

test("cockpit copy resolves from the hrm catalog, never inline English", () => {
  for (const key of [
    "home.title",
    "home.vitals.headcount",
    "home.vitals.openPositions",
    "home.trend.title",
    "home.attention.title",
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

test("the cockpit rail carries the recruiting funnel panel behind its own grant", () => {
  assert.match(view, /data\.recruiting/, "rail renders the recruiting panel when the loader resolves it");
  assert.match(view, /hrm-recruiting-panel/, "rail composes the funnel widget, never a bespoke panel");
  assert.match(loader, /loadRecruitingOverview/, "figures resolve through the canonical recruiting read service");
  assert.match(loader, /can\(authz, 'hrm\.recruiting\.read'\)/, "the panel shows only for the funnel read grant");
  assert.match(hrmWidgets, /'hrm-recruiting-panel'/, "the funnel widget lives in the hrm family");
  assert.match(names, /'hrm-recruiting-panel'/, "the registry names the funnel widget");
  assert.match(contracts, /'hrm-recruiting-panel'/, "widget contracts cover the funnel widget");
  for (const key of ["title", "open", "awaiting", "interviews", "viewAll"]) {
    assert.ok(strings.includes(`"${key}"`), `en/hrm carries home.recruiting.${key}`);
  }
});
