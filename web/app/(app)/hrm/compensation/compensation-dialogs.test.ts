// source-pin-contract: every literal ?<param>=new href is armed where it lands; subjects derived by walking web/lib and web/app
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { join } from "node:path";
import test from "node:test";
import type * as TS from "typescript";

// OM-15: /hrm/compensation's "New plan" and "New cycle" buttons navigated
// to ?plan=new / ?cycle=new and nothing opened — the loader never read the
// params, the spec never emitted the hrm-comp-plan-dialog /
// hrm-comp-cycle-dialog widgets the registry already implements, and the
// page dropped its own searchParams on the floor. The equity "Generate
// snapshot" button (?generate=1) was the same shape one route over.
//
// The seams below stub I/O only (feature switches, group tabs, engine list
// reads, translations backed by the REAL en catalogs). Grants ride a
// fabricated Authz through the stubbed `can` — permission logic itself is
// proven by the existing scope DB tests, not doubled here.
const hrmCatalog = JSON.parse(
  readFileSync(new URL("../../../../messages/en/hrm.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const shellRouteState = (
  JSON.parse(readFileSync(new URL("../../../../messages/en/shell.json", import.meta.url), "utf8")) as Record<
    string,
    unknown
  >
).routeState as Record<string, unknown>;
const adminCatalog = JSON.parse(
  readFileSync(new URL("../../../../messages/en/admin.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

(globalThis as Record<string, unknown>).__compDlgCatalogs = { hrm: hrmCatalog, routeState: shellRouteState, admin: adminCatalog };

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    const parent = context.parentURL ?? "";
    const owned =
      parent.endsWith("/web/lib/hrm/compensation.ts") || parent.endsWith("/web/lib/hrm/workspace-tabs.ts");
    if (owned && specifier === "next-intl/server") {
      return {
        shortCircuit: true,
        format: "module",
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export async function getTranslations(ns) {
              const catalogs = globalThis.__compDlgCatalogs;
              const catalog = ns === 'shell.routeState' ? catalogs.routeState : ns === 'admin' ? catalogs.admin : catalogs.hrm;
              const lookup = (key) => {
                let node = catalog;
                for (const part of key.split('.')) {
                  if (node !== null && typeof node === 'object') node = node[part];
                  else return key;
                }
                return typeof node === 'string' ? node : key;
              };
              const t = (key, params) => {
                const template = lookup(key);
                if (!params) return template;
                return template.replace(/\\{(\\w+)\\}/g, (_, name) => (params[name] === undefined ? '{' + name + '}' : String(params[name])));
              };
              t.has = (key) => lookup(key) !== key;
              return t;
            }`,
          ),
      };
    }
    if (owned && specifier === "../authz") {
      return {
        shortCircuit: true,
        format: "module",
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export const can = (authz, perm) => authz.permissions.has('*') || authz.permissions.has(perm);
             export async function getAuthz() { return null; }`,
          ),
      };
    }
    if (specifier === "../features") {
      return {
        shortCircuit: true,
        format: "module",
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export async function isFeatureEnabled(orgId, key) {
              const flags = globalThis.__compDlgFeatures;
              if (flags && key in flags) return flags[key];
              return true;
            }`,
          ),
      };
    }
    if (specifier === "../feature-gates") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export async function requireFeatureEnabled() {}",
      };
    }
    if (owned && specifier === "../../components/module-home/group-tabs") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export async function hrmGroupTabs() { return []; }",
      };
    }
    if (owned && specifier === "@openbooks/engine/src/platform/business-date.ts") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export async function businessToday() { return '2026-09-22'; }",
      };
    }
    if (owned && specifier === "@openbooks/engine/src/hrm/compensation/cycles.ts") {
      return {
        shortCircuit: true,
        format: "module",
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `const detail = () => globalThis.__compDlgDetail === true;
             export async function listCycles() { return []; }
             export async function listCycleLines() { return []; }
             export async function cyclePacing() { return { totalPct: null, overBudget: false }; }
             export async function getCycle() {
               if (!detail()) return null;
               return { id: 'cycle-1', name: 'Fall merit round', kind: 'merit', status: 'open', effectiveOn: '2026-10-01' };
             }`,
          ),
      };
    }
    if (owned && specifier === "@openbooks/engine/src/hrm/compensation/bands.ts") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export async function listPayBands() { return []; } export async function compaRatioFor() { return null; }",
      };
    }
    if (owned && specifier === "@openbooks/engine/src/hrm/compensation/band-headcounts.ts") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export async function countBandHolders() { return 0; }",
      };
    }
    if (owned && specifier === "@openbooks/engine/src/hrm/compensation/architecture.ts") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export async function listJobLevels() { return []; }",
      };
    }
    if (owned && specifier === "@openbooks/engine/src/hrm/compensation/headcount-plans.ts") {
      return {
        shortCircuit: true,
        format: "module",
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export async function listPlans() {
               if (globalThis.__compDlgDetail !== true) return [];
               return [{ id: 'plan-1', name: 'FY27 growth', status: 'draft', fiscalPeriodFrom: '2026-01-01', fiscalPeriodTo: '2026-12-31' }];
             }
             export async function listPlanLines() { return []; }`,
          ),
      };
    }
    if (owned && specifier === "@openbooks/engine/src/hrm/compensation/pay-transparency.ts") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export async function latestGapSnapshot() { return null; }",
      };
    }
    if (owned && specifier === "@openbooks/engine/src/platform/db.ts") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript," + encodeURIComponent(`export const db = { execute: async () => ({ rows: [] }) };`),
      };
    }
    return nextResolve(specifier, context);
  },
});

const { loadCompensationHome, loadCompCycleDetail, loadHeadcountPlanDetail, loadEquity, lineActionAvailability } =
  await import("../../../../lib/hrm/compensation.ts");

const gap = globalThis as Record<string, unknown>;

function authzWith(permissions: string[]) {
  return {
    user: { orgId: "org-comp-dlg", id: "actor-comp-dlg" },
    permissions: new Set(permissions),
    allowedSubsidiaryIds: null,
  } as never;
}

const MANAGER = authzWith(["hrm.compensation.read", "hrm.compensation.manage", "admin.setup.manage"]);
const MANAGER_NO_SETUP = authzWith(["hrm.compensation.read", "hrm.compensation.manage"]);
const READER = authzWith(["hrm.compensation.read"]);

function features(flags: Record<string, boolean>) {
  gap.__compDlgFeatures = flags;
}

test("?plan=new resolves an open plan dialog with the existing create form", async () => {
  features({ hrmMeritCycles: true, hrmHeadcountPlans: true });
  const data = await loadCompensationHome(MANAGER, { plan: "new" });
  assert.ok(data, "the home loader still resolves");
  assert.equal(data.planOpen, true, "?plan=new opens the plan dialog");
  assert.equal(data.cycleOpen, false, "the cycle dialog stays shut");
  assert.equal(data.cycleDialog, null, "no cycle state leaks across dialogs");
  const dialog = data.planDialog;
  assert.ok(dialog, "the plan dialog resolves instead of nothing");
  assert.equal(dialog.open, true, "the widget's open state is set");
  assert.equal(dialog.closeHref, "/hrm/compensation", "closing navigates the param away");
  assert.equal(dialog.title, "New plan", "the title reuses the existing button copy");
  assert.equal(dialog.nameLabel, "Name", "labels reuse the existing catalog, never new keys");
  assert.ok(dialog.fromLabel.length > 0 && dialog.toLabel.length > 0, "the period labels resolve");
  assert.equal(dialog.refusal, null, "every prerequisite holds, so no refusal rides along");
  assert.equal(dialog.remedyHref, null, "no remedy link beside a form");
});

test("?cycle=new resolves an open cycle dialog over the four engine kinds", async () => {
  features({ hrmMeritCycles: true, hrmHeadcountPlans: true });
  const data = await loadCompensationHome(MANAGER, { cycle: "new" });
  assert.ok(data, "the home loader still resolves");
  assert.equal(data.cycleOpen, true, "?cycle=new opens the cycle dialog");
  assert.equal(data.planOpen, false, "the plan dialog stays shut");
  const dialog = data.cycleDialog;
  assert.ok(dialog, "the cycle dialog resolves instead of nothing");
  assert.equal(dialog.open, true, "the widget's open state is set");
  assert.equal(dialog.closeHref, "/hrm/compensation", "closing navigates the param away");
  assert.deepEqual(
    dialog.kinds.map((k) => k.value),
    ["merit", "promotion", "adjustment", "cola"],
    "the kind picker covers the engine's closed kind set",
  );
  for (const kind of dialog.kinds) {
    assert.ok(!kind.label.includes("."), `kind ${kind.value} resolves to prose, never a key path`);
  }
  assert.equal(dialog.refusal, null, "every prerequisite holds, so no refusal rides along");
});

test("a requested dialog without the manage grant names the grant and its remedy", async () => {
  features({ hrmMeritCycles: true, hrmHeadcountPlans: true });
  const plan = await loadCompensationHome(READER, { plan: "new" });
  assert.equal(plan?.planOpen, true, "the dialog still opens — a refusal, never nothing");
  assert.ok(plan?.planDialog, "the plan dialog resolves");
  assert.equal(plan.planDialog.refusal?.title, "You don't have access", "the shared denial title, not a new key");
  assert.match(plan.planDialog.refusal?.message ?? "", /hrm\.compensation\.manage/, "the missing grant is named");
  assert.match(
    plan.planDialog.refusal?.message ?? "",
    /ask your administrator/,
    "the remedy names the person to ask",
  );
  assert.equal(plan.planDialog.remedyHref, null, "a missing grant is remedied by a person, never a link");

  const cycle = await loadCompensationHome(READER, { cycle: "new" });
  assert.equal(cycle?.cycleOpen, true, "the cycle dialog still opens");
  assert.match(cycle?.cycleDialog?.refusal?.message ?? "", /hrm\.compensation\.manage/, "the grant is named there too");
});

test("a switched-off sub-feature names the feature with the real switch for setup managers", async () => {
  features({ hrmMeritCycles: false, hrmHeadcountPlans: false });
  const cycle = await loadCompensationHome(MANAGER, { cycle: "new" });
  assert.equal(cycle?.cycleOpen, true, "the dialog still opens");
  assert.equal(cycle?.cycleDialog?.refusal?.title, "Merit cycles is turned off", "the switchboard display name, not the key");
  assert.match(
    cycle?.cycleDialog?.refusal?.message ?? "",
    /needs the Merit cycles feature/,
    "the message names the feature with the shared feature-off copy",
  );
  assert.equal(cycle?.cycleDialog?.remedyHref, "/admin/setup/features", "setup managers get the real switch");
  assert.ok(
    (cycle?.cycleDialog?.remedyLabel ?? "").length > 0,
    "the switch link carries prose, never a key path",
  );

  const plan = await loadCompensationHome(MANAGER, { plan: "new" });
  assert.equal(plan?.planDialog?.refusal?.title, "Headcount plans is turned off", "the plan switch is named too");
  assert.equal(plan?.planDialog?.remedyHref, "/admin/setup/features", "and linked too");
});

test("a switched-off sub-feature without setup rights names the administrator instead", async () => {
  features({ hrmMeritCycles: false, hrmHeadcountPlans: true });
  const data = await loadCompensationHome(MANAGER_NO_SETUP, { cycle: "new" });
  assert.ok(data?.cycleDialog?.refusal, "the refusal still rides along");
  assert.equal(data.cycleDialog.remedyHref, null, "no switch link for viewers who cannot toggle it");
  assert.match(
    data.cycleDialog.refusal.message,
    /ask your administrator/,
    "the message names the person to ask instead",
  );
});

test("permission refusal wins over feature-off: the switch cannot help without the grant", async () => {
  features({ hrmMeritCycles: false, hrmHeadcountPlans: false });
  const data = await loadCompensationHome(READER, { cycle: "new" });
  assert.match(
    data?.cycleDialog?.refusal?.message ?? "",
    /hrm\.compensation\.manage/,
    "the grant is named first",
  );
  assert.equal(data?.cycleDialog?.remedyHref, null, "no switch link beside a grant refusal");
});

test("no dialog params means no dialog state", async () => {
  features({ hrmMeritCycles: true, hrmHeadcountPlans: true });
  const data = await loadCompensationHome(MANAGER, {});
  assert.equal(data?.planOpen, false, "plan stays shut");
  assert.equal(data?.cycleOpen, false, "cycle stays shut");
  assert.equal(data?.planDialog, null, "no plan payload");
  assert.equal(data?.cycleDialog, null, "no cycle payload");
});

test("equity ?generate=1 resolves the snapshot dialog, or its named refusal", async () => {
  features({ hrmPayTransparency: true });
  const open = await loadEquity(MANAGER, { generate: "1" });
  assert.equal(open?.generateOpen, true, "?generate=1 opens the dialog");
  assert.ok(open?.generateDialog, "the dialog resolves instead of nothing");
  assert.equal(open.generateDialog.open, true, "the widget's open state is set");
  assert.equal(open.generateDialog.closeHref, "/hrm/compensation/equity", "closing navigates the param away");
  assert.equal(open.generateDialog.groupALabel, "Group A", "the group labels resolve, never key paths");
  assert.equal(open.generateDialog.groupBLabel, "Group B", "the group labels resolve, never key paths");
  assert.equal(open.generateDialog.refusal, null, "managers get the form");

  const refused = await loadEquity(READER, { generate: "1" });
  assert.equal(refused?.generateOpen, true, "the dialog still opens for readers");
  assert.match(
    refused?.generateDialog?.refusal?.message ?? "",
    /hrm\.compensation\.manage/,
    "the missing grant is named",
  );

  const shut = await loadEquity(MANAGER, {});
  assert.equal(shut?.generateOpen, false, "no param, no dialog");
  assert.equal(shut?.generateDialog, null, "no payload either");
});

interface SpecBlock {
  widget?: string;
  when?: unknown;
}

function widgetBlocks(spec: unknown, name: string): SpecBlock[] {
  const body = (spec as { body: SpecBlock[] }).body;
  return body.filter((block) => block.widget === name);
}

test("both specs emit the dialog widgets gated on the loader-derived open state", async () => {
  features({ hrmMeritCycles: true, hrmHeadcountPlans: true, hrmPayTransparency: true });
  const { compensationSpec } = await import("./view.ts");
  const { equitySpec } = await import("./equity/view.ts");
  // The open state lives in the loader data (proven above); the spec carries
  // the widget with a `when` gate on that flag — ModuleView resolves the
  // field refs at render, so the assertion is on the gate, not on prose.
  const home = await loadCompensationHome(MANAGER, { plan: "new", cycle: "new" });
  assert.equal(home?.cycleOpen, true, "the loader reports the cycle dialog open");
  assert.equal(home?.planOpen, true, "the loader reports the plan dialog open");
  assert.equal(home?.cycleDialog?.open, true, "the cycle payload carries its open state");
  assert.equal(home?.planDialog?.open, true, "the plan payload carries its open state");
  const homeSpec = compensationSpec(home!);
  assert.deepEqual(widgetBlocks(homeSpec, "hrm-comp-cycle-dialog").map((b) => b.when), [{ $: "cycleOpen" }], "the cycle widget renders once, gated on its open state");
  assert.deepEqual(widgetBlocks(homeSpec, "hrm-comp-plan-dialog").map((b) => b.when), [{ $: "planOpen" }], "the plan widget renders once, gated on its open state");

  const shut = await loadCompensationHome(MANAGER, {});
  assert.equal(shut?.cycleOpen, false, "no param, no open state");
  assert.equal(shut?.planOpen, false, "no param, no open state");
  assert.equal(shut?.cycleDialog, null, "no payload either");
  assert.equal(shut?.planDialog, null, "no payload either");

  const equity = await loadEquity(MANAGER, { generate: "1" });
  assert.equal(equity?.generateOpen, true, "the loader reports the generate dialog open");
  const equitySpecOut = equitySpec(equity!);
  assert.deepEqual(
    widgetBlocks(equitySpecOut, "hrm-comp-equity-dialog").map((b) => b.when),
    [{ $: "generateOpen" }],
    "the equity widget renders once, gated on its open state",
  );
});

// The pin test this replaced ('the loader, spec, and page thread the
// params end to end') asserted single-file source text; every behaviour
// it named stays covered by the loader/spec behaviour tests above.
// What remains below is the derived repo-wide invariant, kept under the
// contract header at the top of this file.

// The OM-15 sweep guard: every literal `?<param>=new` href emitted anywhere
// in web/lib or web/app must be armed — the emitting file or the target
// route's own directory reads sp.<param>, or the pair is allowlisted below
// with its reason. A new dead link (a button navigating to a query string
// nothing reads) fails here, not in a browser.
const ROOT = join(import.meta.dirname, "..", "..", "..", "..", "..");
const ts: typeof TS = createRequire(join(ROOT, "web", "package.json"))("typescript");

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) found.push(full);
  }
  return found;
}

function literalHrefs(file: string): string[] {
  const text = readFileSync(file, "utf8");
  if (!text.includes("=new")) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hrefs: string[] = [];
  const visit = (node: TS.Node): void => {
    if (ts.isStringLiteralLike(node) && node.text.includes("=new")) hrefs.push(node.text);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return hrefs;
}

/** route|param pairs armed outside the emitting file and target route dir. */
const ARMED_ELSEWHERE = new Map<string, string>([
  // The stock-locations tab on /inventory is the generic setup surface: the
  // row drawer reads sp.row in SetupEntitySection (admin/setup/[entity]),
  // fed by searchParams passthrough in inventory/page.tsx.
  ["/inventory|row", "generic SetupEntitySection row drawer via searchParams passthrough"],
]);

function routeDirReadsParam(route: string, param: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(join(ROOT, "web", "app", "(app)", route));
  } catch {
    return false;
  }
  const probe = new RegExp(`sp\\.${param}\\b`);
  for (const entry of entries) {
    const full = join(ROOT, "web", "app", "(app)", route, entry);
    try {
      if (statSync(full).isFile() && /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        if (probe.test(readFileSync(full, "utf8"))) return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

test("every literal ?<param>=new href is armed where it lands", () => {
  const offenders: string[] = [];
  const seen = new Set<string>();
  for (const root of [join(ROOT, "web", "lib"), join(ROOT, "web", "app")]) {
    for (const file of sourceFiles(root)) {
      const emitter = readFileSync(file, "utf8");
      for (const href of literalHrefs(file)) {
        const queryIndex = href.indexOf("?");
        if (queryIndex < 0 || !href.startsWith("/")) continue;
        const route = href.slice(0, queryIndex);
        const params = new URLSearchParams(href.slice(queryIndex + 1));
        for (const [param, value] of params) {
          if (value !== "new") continue;
          const key = `${route}|${param}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const armed = new RegExp(`sp\\.${param}\\b`).test(emitter) || routeDirReadsParam(route, param);
          if (!armed && !ARMED_ELSEWHERE.has(key)) {
            offenders.push(`${key} (emitted by ${file.slice(ROOT.length + 1)}, nothing reads sp.${param})`);
          }
        }
      }
    }
  }
  assert.ok(seen.size > 0, "the href scan found nothing — the guard is blind, not green");
  assert.deepEqual(offenders, [], `dead ?<param>=new links (a URL nothing reads):\n${offenders.join("\n")}`);
});

// F3-27/F3-28/F3-29: the bands, cycles, plans, team-grid and plan-line
// tables headed their columns with hard-coded English literals ('level',
// 'employee', 'title', …), so every non-English locale still read English.
// The loaders already resolved the catalog strings; the specs just never
// used them. The walker below collects every table's headers in order from
// the emitted spec — ModuleView resolves the field refs at render, so a
// header of {$: 'bandsColumns.level'} renders the loader-resolved catalog
// string while a literal 'level' renders English everywhere.
function tableHeaders(spec: unknown): unknown[][] {
  const found: unknown[][] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    if (node !== null && typeof node === "object") {
      const record = node as Record<string, unknown>;
      if (record.kind === "table" && Array.isArray(record.columns)) {
        found.push((record.columns as { header: unknown }[]).map((column) => column.header));
      }
      for (const value of Object.values(record)) visit(value);
    }
  };
  visit((spec as { body: unknown }).body);
  return found;
}

function assertProse(value: unknown, label: string) {
  assert.equal(typeof value, "string", `${label} resolves to a string, never a key path`);
  assert.ok(!(value as string).includes("."), `${label} resolves to prose, never a key path`);
}

test("home tables head their columns from the resolved catalog, never literals", async () => {
  features({ hrmMeritCycles: true, hrmHeadcountPlans: true });
  const data = await loadCompensationHome(MANAGER, {});
  assert.ok(data, "the home loader still resolves");
  assert.deepEqual(
    [data.bandsColumns.level, data.bandsColumns.range, data.bandsColumns.headcount],
    ["Level", "Range", "Headcount"],
    "the band headers resolve from the en catalog",
  );
  assert.deepEqual(
    [data.cyclesColumns.name, data.cyclesColumns.status, data.cyclesColumns.effective],
    ["Name", "Status", "Effective"],
    "the cycle headers resolve from the en catalog",
  );
  assert.deepEqual(
    [data.plansColumns.name, data.plansColumns.status, data.plansColumns.cost],
    ["Name", "Status", "Cost"],
    "the plan headers resolve from the en catalog",
  );
  const { compensationSpec } = await import("./view.ts");
  assert.deepEqual(
    tableHeaders(compensationSpec(data!)),
    [
      [{ $: "bandsColumns.level" }, { $: "bandsColumns.range" }, { $: "bandsColumns.headcount" }],
      [{ $: "cyclesColumns.name" }, { $: "cyclesColumns.status" }, { $: "cyclesColumns.effective" }],
      [{ $: "plansColumns.name" }, { $: "plansColumns.status" }, { $: "plansColumns.cost" }],
    ],
    "the three home tables head their columns from the loader-resolved fields",
  );
});

test("the team grid heads its seven columns from the resolved catalog, never literals", async () => {
  features({ hrmMeritCycles: true, hrmHeadcountPlans: true });
  (gap as Record<string, unknown>).__compDlgDetail = true;
  try {
    const data = await loadCompCycleDetail(MANAGER, "cycle-1", {});
    assert.ok(data, "the cycle detail loader resolves the canned round");
    for (const [key, value] of Object.entries(data.columns)) assertProse(value, `columns.${key}`);
    assert.equal(data.columns.employee, "Employee", "the employee header resolves from the en catalog");
    const { compCycleSpec } = await import("./cycles/[id]/view.ts");
    assert.deepEqual(
      tableHeaders(compCycleSpec(data!)),
      [
        [
          { $: "columns.employee" },
          { $: "columns.current" },
          { $: "columns.placement" },
          { $: "columns.rating" },
          { $: "columns.guideline" },
          { $: "columns.proposed" },
          { $: "columns.status" },
        ],
      ],
      "the team grid heads all seven columns from the loader-resolved fields",
    );
  } finally {
    (gap as Record<string, unknown>).__compDlgDetail = false;
  }
});

test("the plan lines head their six columns from the resolved catalog, never literals", async () => {
  features({ hrmMeritCycles: true, hrmHeadcountPlans: true });
  (gap as Record<string, unknown>).__compDlgDetail = true;
  try {
    const data = await loadHeadcountPlanDetail(MANAGER, "plan-1");
    assert.ok(data, "the plan detail loader resolves the canned plan");
    for (const [key, value] of Object.entries(data.columns)) assertProse(value, `columns.${key}`);
    assert.equal(data.columns.title, "Title", "the title header resolves from the en catalog");
    const { compPlanSpec } = await import("./plans/[id]/view.ts");
    assert.deepEqual(
      tableHeaders(compPlanSpec(data!)),
      [
        [
          { $: "columns.title" },
          { $: "columns.kind" },
          { $: "columns.fte" },
          { $: "columns.start" },
          { $: "columns.cost" },
          { $: "columns.status" },
        ],
      ],
      "the plan lines head all six columns from the loader-resolved fields",
    );
  } finally {
    (gap as Record<string, unknown>).__compDlgDetail = false;
  }
});

test("the line drawer arms only the actions the transition table allows", () => {
  // F3-38: propose while the round is live and the line is undecided;
  // decide while the round is live or approved and the line is proposed.
  // Anything else hides the forms — the engine refuses them anyway.
  const cases: Array<[string, string | null, boolean, boolean]> = [
    ["open", "pending", true, false],
    ["open", "proposed", true, true],
    ["in_review", "proposed", true, true],
    ["approved", "proposed", false, true],
    ["approved", "approved", false, false],
    ["pushed", "proposed", false, false],
    ["pushed", "pushed", false, false],
    ["closed", "approved", false, false],
    ["cancelled", "pending", false, false],
    ["open", null, false, false],
  ];
  for (const [cycle, line, canPropose, canDecideLine] of cases) {
    assert.deepEqual(
      lineActionAvailability(cycle, line),
      { canPropose, canDecideLine },
      `${cycle}/${line ?? "none"} arms exactly its actions`,
    );
  }
});
