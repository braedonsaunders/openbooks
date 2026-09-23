import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

// Compensation home and equity loaders must surface a refused
// latestGapSnapshot read (a scoped reader cannot read org-wide frozen
// aggregates) as data with the named remedy intact — never a zero
// joint-flag count or an empty page pretending the read succeeded.
// Genuinely absent snapshots keep the empty state; unexpected DB/system
// failures propagate.
//
// The seams below stub I/O only (feature switches, group tabs, the engine
// snapshot query and its sibling list reads, the translations loader backed
// by the REAL en catalog). The refusal classes are the real engine errors,
// and authz stubbing is the sanctioned seam — permission logic itself is
// proven by the existing scope DB tests, not doubled here.
const catalog = JSON.parse(
  readFileSync(new URL("../../../../messages/en/hrm.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
function lookup(key: string): string {
  const parts = key.split(".");
  let node: unknown = catalog;
  for (const part of parts) {
    if (node !== null && typeof node === "object") node = (node as Record<string, unknown>)[part];
    else return key;
  }
  return typeof node === "string" ? node : key;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    const parent = context.parentURL ?? "";
    // The translations seam must follow the loader's callees, not just the
    // loader: loadEquity now builds its tab strip through workspace-tabs.ts,
    // and an import that falls through here resolves next-intl's CLIENT build,
    // which throws `getTranslations is not supported in Client Components`
    // from a module this test never meant to exercise.
    const owned =
      parent.endsWith("/web/lib/hrm/compensation.ts") ||
      parent.endsWith("/web/lib/hrm/workspace-tabs.ts");
    if (owned && specifier === "next-intl/server") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export async function getTranslations() { const base = globalThis.__f17t; const t = (key) => base(key); t.has = (key) => base.has(key); return t; }",
      };
    }
    if (owned && specifier === "../authz") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export const can = () => true; export async function getAuthz() { return null; }",
      };
    }
    // The feature gate is stubbed for EVERY importer, not just the two
    // loaders under test: the gate is also reached through
    // ../feature-gates (requireFeatureEnabled) and web/lib/hrm/home.ts,
    // and a parent-scoped stub lets those edges fall through to the real
    // `select settings->'features' from orgs` read. The unit partition has
    // no database, so every such edge must be stubbed. All cases run with
    // the gates on (the off-switch remedy is pinned by
    // compensation-page.test.ts); the loaders' real refusal and error
    // classes stay intact.
    if (specifier === "../features") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export async function isFeatureEnabled(orgId, key) { const flags = globalThis.__f17Features; if (flags && key in flags) return flags[key]; return true; }",
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
    if (owned && specifier === "@openbooks/engine/src/hrm/compensation/pay-transparency.ts") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export async function latestGapSnapshot() { const s = globalThis.__f17Gap; if (s && s.error) throw s.error; return s ? s.snapshot : null; }",
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
        url: "data:text/javascript,export async function listCycles() { return []; } export async function listCycleLines() { return []; } export async function cyclePacing() { return null; } export async function getCycle() { return null; }",
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
        url: "data:text/javascript,export async function listPlans() { return []; } export async function listPlanLines() { return []; }",
      };
    }
    return nextResolve(specifier, context);
  },
});

// The translations stub resolves against the real catalog so refusal titles
// prove the key ships, not that a double echoes.
const translate = (key: string) => lookup(key);
(globalThis as Record<string, unknown>).__f17t = Object.assign(translate, {
  has: (key: string) => lookup(key) !== key,
});

const { loadCompensationHome, loadEquity } = await import("../../../../lib/hrm/compensation.ts");
const { CompensationError } = await import(
  "@openbooks/engine/src/hrm/compensation/errors.ts"
);
const { HrmAuthorizationError } = await import("@openbooks/engine/src/hrm/authorization.ts");

const gap = globalThis as Record<string, unknown>;
const authz = { user: { orgId: "org-f17", id: "actor-f17" } } as never;

// The read refusal for a subsidiary-restricted role: it cannot read an
// org-wide frozen aggregate.
const SCOPE_REFUSAL =
  "pay-gap snapshots measure the whole organization — a role restricted to specific subsidiaries (or to none) cannot read an org-wide frozen aggregate without seeing every worker it covers, and frozen aggregates cannot be post-filtered. Ask an administrator to grant hrm.compensation.read with access to all subsidiaries (no subsidiary restriction) to read gap snapshots.";

function validSnapshot() {
  return {
    id: "snap-1",
    asOf: "2026-09-01",
    metrics: {
      comparisonAttributeKey: "group",
      thresholdPct: 5,
      groupA: "a",
      groupB: "b",
      meanGapPct: 2.5,
      medianGapPct: 1.5,
      variablePayGapPct: null,
      quartileProportions: [],
      headcountA: 4,
      headcountB: 4,
      reportingCurrency: "USD",
      fxEvidence: {},
    },
    categories: [
      {
        levelId: "lvl-1",
        levelCode: "L3",
        familyId: null,
        countA: 2,
        countB: 2,
        meanGapPct: 6.1,
        medianGapPct: 5.2,
        unexplainedGapPct: 6.1,
        method: "ols",
        jointAssessmentDue: true,
      },
      {
        levelId: "lvl-2",
        levelCode: "L4",
        familyId: null,
        countA: 2,
        countB: 2,
        meanGapPct: 0.4,
        medianGapPct: 0.1,
        unexplainedGapPct: 0.4,
        method: "ols",
        jointAssessmentDue: true,
      },
    ],
    generatedAt: "2026-09-02",
  };
}

test("equity surfaces a refused snapshot read with the named remedy, not an empty page", async () => {
  gap.__f17Gap = { error: new CompensationError("REFUSED", SCOPE_REFUSAL) };
  const data = await loadEquity(authz);
  assert.ok(data, "the equity loader still resolves");
  assert.equal(data.hasSnapshot, false, "no snapshot is claimed");
  assert.deepEqual(data.tiles, [], "no metric tiles pretend to measure");
  assert.deepEqual(data.categories, [], "no category rows pretend to measure");
  assert.ok(data.refusal, "the refusal travels as data");
  assert.equal(data.refusal.title, "Pay equity", "the banner reuses the existing page title");
  assert.equal(data.refusal.message, SCOPE_REFUSAL, "the remedy arrives verbatim");
  assert.equal(data.hasContent, false, "the snapshot grid and table suppress while refused");
});

test("equity surfaces an authorization refusal the same way", async () => {
  gap.__f17Gap = {
    error: new HrmAuthorizationError("compensation reads need the hrm.compensation.read grant in this organization."),
  };
  const data = await loadEquity(authz);
  assert.ok(data?.refusal, "the auth refusal travels as data");
  assert.match(data.refusal.message, /hrm\.compensation\.read/, "the missing grant is named");
});

test("equity keeps the genuine no-snapshot empty state", async () => {
  gap.__f17Gap = { snapshot: null };
  const data = await loadEquity(authz);
  assert.ok(data, "the equity loader still resolves");
  assert.equal(data.hasSnapshot, false, "absence is still reported");
  assert.equal(data.refusal, null, "absence is not a refusal");
  assert.equal(data.hasContent, true, "genuine emptiness keeps its table");
  assert.equal(data.emptyTitle, "No snapshot yet", "the empty copy is preserved");
});

test("equity preserves a valid snapshot untouched", async () => {
  gap.__f17Gap = { snapshot: validSnapshot() };
  const data = await loadEquity(authz);
  assert.equal(data?.hasSnapshot, true, "the snapshot is claimed");
  assert.equal(data?.refusal, null, "success carries no refusal");
  assert.equal(data?.hasContent, true, "a valid snapshot renders its grid and table");
  assert.equal(data?.tiles.length, 4, "all four metric tiles render");
  assert.equal(data?.tiles[3]?.value, "2", "both joint-assessment flags count");
  assert.equal(data?.categories.length, 2, "both categories render");
});

test("equity propagates an unexpected system failure instead of an empty page", async () => {
  gap.__f17Gap = { error: new TypeError("connection terminated") };
  await assert.rejects(loadEquity(authz), /connection terminated/, "the failure reaches the caller, never a null snapshot");
});

test("home shows unavailable — never zero — for a refused joint-flag total", async () => {
  gap.__f17Gap = { error: new CompensationError("REFUSED", SCOPE_REFUSAL) };
  const data = await loadCompensationHome(authz);
  assert.ok(data, "the home loader still resolves");
  assert.ok(data.refusal, "the refusal travels as data");
  assert.equal(data.refusal.title, "Compensation", "the banner reuses the existing page title");
  assert.equal(data.refusal.message, SCOPE_REFUSAL, "the remedy arrives verbatim");
  const joint = data.tiles[3];
  assert.equal(joint?.label, "Joint assessment flags", "the flag tile stays in place");
  assert.equal(joint?.value, "—", "hidden flags read unavailable, never numeric zero");
  assert.equal(joint?.tone, "default", "no warning fires on an unknown count");
});

test("home still counts zero flags when the snapshot is genuinely absent", async () => {
  gap.__f17Gap = { snapshot: null };
  const data = await loadCompensationHome(authz);
  assert.equal(data?.refusal, null, "absence is not a refusal");
  assert.equal(data?.tiles[3]?.value, "0", "a genuinely absent snapshot still counts zero");
});

test("home counts joint flags from a valid snapshot", async () => {
  gap.__f17Gap = { snapshot: validSnapshot() };
  const data = await loadCompensationHome(authz);
  assert.equal(data?.refusal, null, "success carries no refusal");
  assert.equal(data?.tiles[3]?.value, "2", "both joint-assessment flags count");
  assert.equal(data?.tiles[3]?.tone, "warning", "flags raise the warning tone");
});

test("home propagates an unexpected system failure instead of a zero tile", async () => {
  gap.__f17Gap = { error: new Error("db went away") };
  await assert.rejects(loadCompensationHome(authz), /db went away/, "the failure reaches the caller, never a zero tile");
});

test("both specs render the refusal through the house empty-state block", async () => {
  const homeView = readFileSync(new URL("./view.ts", import.meta.url), "utf8");
  const equityView = readFileSync(new URL("./equity/view.ts", import.meta.url), "utf8");
  const loader = readFileSync(new URL("../../../../lib/hrm/compensation.ts", import.meta.url), "utf8");
  const strings = readFileSync(new URL("../../../../messages/en/hrm.json", import.meta.url), "utf8");
  for (const [name, view] of [["home", homeView], ["equity", equityView]] as const) {
    assert.match(
      view,
      /widgetBlock\('empty-state', \{ title: data\.refusal\?\.title \?\? '', description: data\.refusal\?\.message \}, f\('refusal'\)\)/,
      `the ${name} spec renders the computed refusal through the shared empty-state block, gated on refusal`,
    );
  }
  assert.match(loader, /refusal: \{ title: string; message: string \} \| null/, "the loader data carries the refusal beside the content");
  assert.match(loader, /t\('compensation\.title'\)/, "the home refusal banner reuses the existing page title");
  assert.match(loader, /t\('equity\.title'\)/, "the equity refusal banner reuses the existing page title");
  assert.ok(!/refusedTitle/.test(loader), "no new refusal-title key is introduced in the loader");
  const catalogNamespaces = JSON.parse(strings) as {
    compensation?: { refusedTitle?: unknown };
    equity?: { refusedTitle?: unknown };
  };
  assert.equal(catalogNamespaces.compensation?.refusedTitle, undefined, "no new refusal-title key under compensation");
  assert.equal(catalogNamespaces.equity?.refusedTitle, undefined, "no new refusal-title key under equity");
  assert.match(equityView, /when: f\('hasContent'\)/, "the equity grid and table gate on content");
  assert.match(
    loader,
    /await countBandHolders\(\{ orgId, actorId: authz\.user\.id, levelId: band\.levelId, asOf: today \}\)/,
    "the scoped holder count stays a bare awaited call",
  );
  assert.ok(!/latestGapSnapshot\([^)]*\)\.catch\(/.test(loader), "no snapshot read swallows its refusal into null");
});

interface SpecBlock {
  kind?: string;
  widget?: string;
  props?: { title?: unknown; description?: unknown };
  when?: unknown;
}

function bodyOf(spec: unknown): SpecBlock[] {
  return (spec as { body: SpecBlock[] }).body;
}

test("the computed refusal reaches the operator surface in both specs", async () => {
  const { compensationSpec } = await import("./view.ts");
  const { equitySpec } = await import("./equity/view.ts");
  gap.__f17Gap = { error: new CompensationError("REFUSED", SCOPE_REFUSAL) };
  const home = await loadCompensationHome(authz);
  const homeSpec = compensationSpec(home!);
  assert.match(JSON.stringify(homeSpec), /empty-state/, "the home spec carries the empty-state block");
  assert.ok(JSON.stringify(homeSpec).includes(SCOPE_REFUSAL), "the home spec embeds the named remedy");
  const equity = await loadEquity(authz);
  const refusedBody = bodyOf(equitySpec(equity!));
  const refusedBanner = refusedBody.find((block) => block.widget === "empty-state");
  assert.ok(refusedBanner, "the refused equity spec carries the empty-state block");
  assert.equal(refusedBanner.props?.title, "Pay equity", "the banner reuses the page title");
  assert.equal(refusedBanner.props?.description, SCOPE_REFUSAL, "the banner embeds the named remedy");
  assert.deepEqual(refusedBanner.when, { $: "refusal" }, "the banner renders only while refused");
  for (const block of refusedBody.filter((candidate) => candidate.kind === "grid" || candidate.kind === "panel")) {
    assert.deepEqual(block.when, { $: "hasContent" }, `the refused ${block.kind} suppresses on missing content`);
  }
  assert.equal(equity!.hasContent, false, "refused data hides the grid and table at render");
});

test("genuine no-snapshot equity keeps its table distinct from a refusal", async () => {
  const { equitySpec } = await import("./equity/view.ts");
  gap.__f17Gap = { snapshot: null };
  const equity = await loadEquity(authz);
  assert.equal(equity!.hasContent, true, "genuine emptiness keeps content");
  const emptyBody = bodyOf(equitySpec(equity!));
  const banner = emptyBody.find((block) => block.widget === "empty-state");
  assert.deepEqual(banner?.when, { $: "refusal" }, "the banner stays hidden without a refusal");
  const tablePanel = emptyBody.find((block) => block.kind === "panel");
  assert.ok(tablePanel, "the genuine empty state still renders its categories panel");
  assert.deepEqual(tablePanel.when, { $: "hasContent" }, "the panel renders because content holds");
});
