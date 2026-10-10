// The HRM cockpit's spec contract, proved through the real hrmSpec builder —
// not by matching view.ts source text. A fixture HrmHomeData goes in, the
// PageSpec tree comes out, and the tests walk that tree: panel order,
// activity gates, vitals icons, header actions, and table composition.
// Loader-resolved facts (gates, scoping, flags) are proved against the
// test database in hrm-home.integration.test.ts.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

// The repository root, with its trailing slash: `@/x` resolves to `web/x`.
const root = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "/")).href;
const { stubModules } = await import("../../../testing/stub-modules");
stubModules({ navigation: "export function redirect(){throw new Error('redirect')}export function useRouter(){return {push(){},refresh(){}}}export function usePathname(){return '/hrm'}export function useSearchParams(){return new URLSearchParams()}", intl: true });
registerHooks({
  resolve(specifier, context, next) {

    if (specifier === "next/server") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export class NextResponse{static json(body,init){return Response.json(body,init)}}",
      };
    }
    if (specifier.startsWith("@/")) {
      const path = `${root}web/${specifier.slice(2)}`;
      for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
        if (existsSync(new URL(path + suffix))) return next(path + suffix, context);
      }
      return next(path, context);
    }
    return next(specifier, context);
  },
});

const { hrmSpec } = await import("./view.ts");
const { monthEndsBefore } = await import("../../../lib/hrm/home.ts");
const { isFieldRef } = await import("@braedonsaunders/appkit-viewspec");
import type { HrmHomeData } from "../../../lib/hrm/home.ts";

type Tree = Record<string, unknown>;

function childrenOf(node: unknown): unknown[] {
  if (Array.isArray(node)) return node;
  if (typeof node === "object" && node !== null) {
    const out: unknown[] = [];
    for (const value of Object.values(node as Tree)) {
      if (Array.isArray(value)) out.push(...value);
      else if (typeof value === "object" && value !== null) out.push(value);
    }
    return out;
  }
  return [];
}

function walk(node: unknown, visit: (node: Tree) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  visit(node as Tree);
  for (const child of childrenOf(node)) walk(child, visit);
}

// Both block widgets (widgetBlock, kind 'widget') and header action refs
// (widget, no kind — the runtime WidgetRef is just {widget, props?, when?}).
function widgetsIn(node: unknown): string[] {
  const names: string[] = [];
  walk(node, (entry) => {
    if (typeof entry.widget === "string") names.push(entry.widget);
  });
  return names;
}

function panelsIn(node: unknown): { when: string | null; widgets: string[] }[] {
  const panels: { when: string | null; widgets: string[] }[] = [];
  walk(node, (entry) => {
    if (entry.kind !== "panel" || !Array.isArray(entry.blocks)) return;
    const when = entry.when;
    panels.push({
      when: isFieldRef(when) ? when.$ : null,
      widgets: widgetsIn(entry.blocks),
    });
  });
  return panels;
}

function statTiles(node: unknown): { iconKey: unknown; accent: unknown }[] {
  const tiles: { iconKey: unknown; accent: unknown }[] = [];
  walk(node, (entry) => {
    if (entry.kind === "stat-tile") tiles.push({ iconKey: entry.iconKey, accent: entry.accent });
  });
  return tiles;
}

function heroGrid(spec: Tree): unknown {
  let hero: unknown = null;
  walk(spec, (entry) => {
    if (entry.kind === "grid" && widgetsIn(entry).includes("hrm-pending-requests")) hero = entry;
  });
  assert.ok(hero, "the spec must render a hero grid led by the pending queue");
  return hero;
}

const ONBOARDING = {
  openCount: 2,
  overdue: [],
  upcoming: [],
  panelTitle: "Onboarding",
  openLabel: "Open",
  overdueLabel: "Overdue",
  upcomingLabel: "Upcoming",
  empty: "All clear",
  viewAll: "View all",
  viewAllHref: "/hrm/processes",
};

const LEAVE_PANEL = {
  title: "Leave",
  onLeaveToday: [],
  onLeaveEmpty: "Nobody out",
  pendingCount: 0,
  pendingLabel: "Pending",
  queueHref: "/hrm/leave",
};

const BENEFITS_PANEL = {
  title: "Benefits",
  openLabel: "Open",
  openWindows: [],
  openEmpty: "No windows",
  pendingCount: 0,
  pendingLabel: "Pending",
  missingCount: 0,
  missingLabel: "Missing",
  queueHref: "/hrm/benefits",
};

const RECRUITING = {
  panelTitle: "Hiring",
  openLabel: "Open",
  openValue: "3",
  awaitingLabel: "Awaiting",
  awaitingValue: "1",
  interviewsLabel: "Interviews",
  interviewsValue: "2",
  viewAll: "View all",
  viewAllHref: "/hrm/recruiting",
};

function fixture(overrides: Partial<HrmHomeData> = {}): HrmHomeData {
  return {
    title: "HR",
    description: "People workspace",
    tabs: [],
    canCreateEmployee: true,
    canProposeChange: true,
    canCreateProcess: true,
    newEmployee: { basePath: "/entities/employees", role: "employee", label: "New employee" },
    newProcessLabel: "New process",
    hireLabel: "Hire employee",
    onboarding: { ...ONBOARDING },
    onboardingHasActivity: true,
    leaveHasActivity: true,
    benefitsHasActivity: true,
    recruitingHasActivity: true,
    multiSubsidiary: false,
    headcountLabel: "Headcount",
    headcountValue: "42",
    headcountSub: "as of today",
    pendingLabel: "Pending",
    pendingValue: "2",
    pendingSub: "requests",
    pendingAccent: "amber",
    pendingHasActivity: true,
    startingLabel: "Starting",
    startingValue: "1",
    startingSub: "next 30 days",
    onLeaveLabel: "On leave",
    onLeaveValue: "0",
    onLeaveSub: "today",
    workforceTitle: "Workforce",
    workforcePulse: [{ label: "Today", value: "42" }],
    mixTitle: "By department",
    trendHint: "12 months",
    trendSeriesName: "Headcount",
    trendLabels: ["Jan"],
    trendData: [40],
    attentionTitle: "Needs attention",
    attentionAllClear: "All clear",
    attention: [],
    groupsTitle: "Headcount",
    employerColumn: "Employer",
    departmentColumn: "Department",
    headcountColumn: "Headcount",
    unassigned: "Unassigned",
    groupsEmpty: "No employees",
    totalLabel: "Total",
    groups: [],
    total: 0,
    totalValue: "0",
    directoryTitle: "Directory",
    directory: [],
    pendingTitle: "Pending requests",
    pendingEmpty: "Nothing pending",
    pendingViewAll: "View queue",
    pendingQueueHref: "/hrm/change-requests",
    pendingRefusal: null,
    pending: [],
    upcomingTitle: "Upcoming",
    upcomingHint: "Next 30 days",
    startsTitle: "Starting",
    startsEmpty: "Nobody starting",
    endsTitle: "Ending",
    endsEmpty: "Nobody ending",
    upcomingTruncated: false,
    upcomingTruncatedNote: "",
    starts: [],
    ends: [],
    recentTitle: "Recent",
    recentEmpty: "No changes",
    recent: [],
    queueNotAvailable: "",
    actionsTitle: "Actions",
    actions: [{ href: "/hrm/change-requests", label: "Propose change", iconKey: "plus" }],
    positions: null,
    leavePanel: { ...LEAVE_PANEL },
    recruiting: { ...RECRUITING },
    benefitsPanel: { ...BENEFITS_PANEL },
    ...overrides,
  } as HrmHomeData;
}

test("the pending queue leads the hero column with subordinate panels below it", () => {
  const panels = panelsIn(heroGrid(hrmSpec(fixture()) as unknown as Tree));
  const first = panels.map((panel) => panel.widgets[0] ?? null);
  assert.equal(first[0], "hrm-pending-requests", "the pending queue leads the hero column");
  for (const widget of ["hrm-onboarding-panel", "hrm-leave-panel", "hrm-benefits-panel", "hrm-recruiting-panel"]) {
    const at = first.indexOf(widget);
    assert.ok(at > 0, `${widget} renders below the pending queue, never above it`);
  }
  assert.ok(first.includes("hrm-recent-changes"), "the hero column carries recent changes");
  const workforce = panels.find((panel) => panel.widgets.includes("hrm-headcount-mix"));
  assert.ok(workforce?.widgets.includes("trend-chart"), "the workforce panel carries the trend chart beside the department mix");
  assert.ok(workforce?.widgets.includes("hrm-pulse"), "the workforce panel leads with its pulse figures");
});

test("month ends step back through month boundaries, leap days included", () => {
  assert.deepEqual(monthEndsBefore("2026-09-22", 3), ["2026-06-30", "2026-07-31", "2026-08-31"]);
  assert.deepEqual(monthEndsBefore("2026-03-15", 2), ["2026-01-31", "2026-02-28"]);
  assert.deepEqual(monthEndsBefore("2024-03-15", 1), ["2024-02-29"]);
  assert.deepEqual(monthEndsBefore("2026-01-05", 1), ["2025-12-31"]);
  assert.deepEqual(monthEndsBefore("2026-09-22", 0), []);
});

test("a refused queue reaches the pending widget with its named remedy", () => {
  const message = "Queue refused — ask an administrator for the queue grant";
  const output = JSON.stringify(hrmSpec(fixture({ pending: [], pendingRefusal: message })));
  assert.ok(output.includes('"hrm-pending-requests"'));
  assert.ok(output.includes(message));
});

test("quiet modules collapse behind their activity flags", () => {
  const panels = panelsIn(heroGrid(hrmSpec(fixture()) as unknown as Tree));
  const gated: Record<string, string | null> = {};
  for (const panel of panels) {
    for (const widget of panel.widgets) gated[widget] = panel.when;
  }
  assert.equal(gated["hrm-onboarding-panel"], "onboardingHasActivity");
  assert.equal(gated["hrm-leave-panel"], "leaveHasActivity");
  assert.equal(gated["hrm-benefits-panel"], "benefitsHasActivity");
  assert.equal(gated["hrm-recruiting-panel"], "recruitingHasActivity");
  assert.equal(gated["hrm-pending-requests"], "pendingHasActivity", "a clear queue collapses; a refusal keeps it open");

  const quiet = panelsIn(
    heroGrid(hrmSpec(fixture({ onboarding: null, leavePanel: null, benefitsPanel: null, recruiting: null })) as unknown as Tree),
  );
  const widgets = quiet.flatMap((panel) => panel.widgets);
  for (const widget of ["hrm-onboarding-panel", "hrm-leave-panel", "hrm-benefits-panel", "hrm-recruiting-panel"]) {
    assert.ok(!widgets.includes(widget), `${widget} collapses when its loader data is null`);
  }
});

test("the vitals strip carries the four named tiles", () => {
  const tiles = statTiles(hrmSpec(fixture()) as unknown as Tree);
  const icons = tiles.map((tile) => tile.iconKey);
  assert.ok(icons.includes("users"), "headcount tiles the people figure");
  assert.ok(icons.includes("clipboard-check"), "the vitals strip carries the pending count");
  assert.ok(icons.includes("calendar-clock"), "the vitals strip carries starting soon");
  const pending = tiles.find((tile) => tile.iconKey === "clipboard-check");
  assert.equal(pending?.accent, "amber", "the pending tile follows the loader-resolved accent");
});

test("the header carries the shared New dropdown with loader grants", () => {
  const found: Tree[] = [];
  walk(hrmSpec(fixture()) as unknown as Tree, (entry) => {
    if (entry.widget === "hrm-new-menu") found.push(entry);
  });
  assert.equal(found.length, 1, "the header carries exactly one New dropdown");
  const props = found[0]?.props as Tree | undefined;
  assert.equal(props?.canCreateEmployee, true, "employee creation keeps its loader-resolved grant");
  assert.equal(props?.canCreateProcess, true, "process creation keeps its loader-resolved grant");
});

test("the department mix binds the census and names the employer only for multi-entity orgs", () => {
  const mix = (multiSubsidiary: boolean): Tree | undefined => {
    let found: Tree | undefined;
    walk(heroGrid(hrmSpec(fixture({ multiSubsidiary })) as unknown as Tree), (entry) => {
      if (entry.widget === "hrm-headcount-mix") found = entry.props as Tree;
    });
    return found;
  };
  const groups = [{ id: "Main / Ops", subsidiary: "Main", department: "Ops", headcount: 3 }];
  let props: Tree | undefined;
  walk(heroGrid(hrmSpec(fixture({ groups })) as unknown as Tree), (entry) => {
    if (entry.widget === "hrm-headcount-mix") props = entry.props as Tree;
  });
  assert.equal(props?.rows, groups, "the mix renders the loader-resolved census rows");
  assert.equal(mix(false)?.showEmployer, false, "a single-entity org sees departments, never an employer line");
  assert.equal(mix(true)?.showEmployer, true, "a multi-entity org gains the employer line");
});

// HRM is a default-off feature owning exactly one nav module: the cockpit.
// Working surfaces are tabs on the cockpit, never sidebar modules of their
// own — a second Departments entry beside Company setup's and a second
