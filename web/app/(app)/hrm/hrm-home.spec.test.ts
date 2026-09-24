// The HRM cockpit's spec contract, proved through the real hrmSpec builder —
// not by matching view.ts source text. A fixture HrmHomeData goes in, the
// PageSpec tree comes out, and the tests walk that tree: panel order,
// activity gates, vitals icons, header actions, and table composition.
// Loader-resolved facts (gates, scoping, flags) are proved against the
// shard database in hrm-home.integration.test.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "")).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: "data:text/javascript,export {}" };
    }
    if (specifier === "next-intl/server") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function getTranslations(){return (key)=>key}export async function getLocale(){return 'en'}",
      };
    }
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function redirect(){throw new Error('redirect')}export function useRouter(){return {push(){},refresh(){}}}export function usePathname(){return '/hrm'}export function useSearchParams(){return new URLSearchParams()}",
      };
    }
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
const { isFieldRef } = await import("@braedonsaunders/appkit-viewspec");
const { NAV_MODULES } = await import("../../../../engine/src/navigation/nav-registry.ts");
const { FEATURE_BY_KEY } = await import("../../../../engine/src/organization/feature-registry.ts");
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

function tables(node: unknown): Tree[] {
  const found: Tree[] = [];
  walk(node, (entry) => {
    if (entry.kind === "table") found.push(entry);
  });
  return found;
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
    startingLabel: "Starting",
    startingValue: "1",
    startingSub: "next 30 days",
    onLeaveLabel: "On leave",
    onLeaveValue: "0",
    onLeaveSub: "today",
    trendTitle: "Trend",
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
  assert.ok(first.includes("trend-chart"), "the hero column carries the trend chart");
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

test("the headcount hero is a table block with a subsidiary column only for multi-entity orgs", () => {
  const single = tables(heroGrid(hrmSpec(fixture({ multiSubsidiary: false })) as unknown as Tree));
  const hero = single.find((table) => {
    const rows = table.rows;
    return isFieldRef(rows) && rows.$ === "groups";
  });
  assert.ok(hero, "the headcount hero binds the loader-resolved groups");
  assert.equal(hero?.variant, "app", "the hero uses the shared app table primitives");
  assert.equal((hero?.columns as unknown[]).length, 2, "a single-entity org sees departments, never a subsidiary column");

  const multi = tables(heroGrid(hrmSpec(fixture({ multiSubsidiary: true })) as unknown as Tree));
  const heroMulti = multi.find((table) => {
    const rows = table.rows;
    return isFieldRef(rows) && rows.$ === "groups";
  });
  assert.equal((heroMulti?.columns as unknown[]).length, 3, "a multi-entity org gains the employer column");
});

// HRM is a default-off feature owning exactly one nav module: the cockpit.
// Working surfaces are tabs on the cockpit, never sidebar modules of their
// own — a second Departments entry beside Company setup's and a second
// Reports entry beside the Reports module were the confusion under review.
test("hrm is registered as a default-off feature with ONE nav module", () => {
  const hrm = FEATURE_BY_KEY.get("hrm");
  assert.ok(hrm, "the Features switchboard must declare hrm");
  assert.equal(hrm.defaultEnabled, false, "hrm defaults off");
  assert.deepEqual(hrm.navModules, ["hrm"], "the feature owns exactly the cockpit module");
  const mod = NAV_MODULES.find((entry) => entry.key === "hrm");
  assert.ok(mod, "the nav registry must open the cockpit");
  assert.equal(mod.href, "/hrm");
  assert.equal(mod.requiredPermission, "hrm.employment.read", "the module carries the read boundary");
  assert.equal(mod.featureKey, "hrm", "the module hides while the feature is off");
  for (const key of ["hrm-change-requests", "hrm-departments", "hrm-reports", "hrm-compliance"]) {
    assert.ok(
      !NAV_MODULES.some((entry) => entry.key === key),
      `${key} is not a nav module`,
    );
  }
});

// Every home.* key the spec binds must resolve in all 7 catalogs — a
// missing key renders the raw path exactly when the cockpit has nothing
// else to say.
const LOCALES = ["en", "de", "es", "fr", "ja", "pt-BR", "zh"] as const;
const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

for (const locale of LOCALES) {
  test(`cockpit home copy resolves translated text in ${locale}`, () => {
    const catalog = JSON.parse(readFileSync(join(webRoot, "messages", locale, "hrm.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const nav = JSON.parse(readFileSync(join(webRoot, "messages", locale, "nav.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const modules = (nav.modules ?? {}) as Record<string, unknown>;
    assert.ok(
      typeof modules.hrm === "string" && (modules.hrm as string).trim().length > 0,
      `${locale} nav.json must label the HRM module, or the sidebar renders the key`,
    );
    if (locale !== "en") {
      assert.notEqual(modules.hrm, "Human Resources", `${locale} nav.json must translate the HRM module label`);
    }
    const home = catalog.home as Record<string, unknown>;
    assert.ok(home && typeof home === "object", `${locale} hrm.json must carry the home namespace`);
    for (const key of ["title", "vitals", "trend", "attention", "groups", "vacancy", "directory", "tabs", "recruiting"]) {
      const value = home[key];
      assert.ok(value !== undefined, `${locale} hrm.json lacks home.${key}`);
    }
  });
}
