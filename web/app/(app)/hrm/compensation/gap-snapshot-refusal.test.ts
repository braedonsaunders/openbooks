import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import React, { Children, isValidElement, type ReactNode } from "react";

// The equity loader must surface a refused
// latestGapSnapshot read (a scoped reader cannot read org-wide frozen
// aggregates) as data with the named remedy intact — never a zero
// joint-flag count or an empty page pretending the read succeeded.
// Genuinely absent snapshots keep the empty state; unexpected DB/system
// failures propagate.
// The architecture Overview reads authorized wage and configuration facts;
// it does not request a frozen organization-wide pay-gap aggregate.
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

const { stubModules } = await import("../../../../testing/stub-modules");
stubModules({ extra: { "../features": "export async function isFeatureEnabled(orgId, key) { const flags = globalThis.__f17Features; if (flags && key in flags) return flags[key]; return true; }" } });
registerHooks({
  resolve(specifier, context, nextResolve) {

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
        url: "data:text/javascript,export async function getTranslations() { const base = globalThis.__f17t; const t = (key) => base(key); t.has = (key) => base.has(key); return t; } export async function getLocale() { return 'en'; }",
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
        url: "data:text/javascript,export async function latestGapSnapshot() { globalThis.__compensationGapReads = (globalThis.__compensationGapReads ?? 0) + 1; const s = globalThis.__f17Gap; if (s && s.error) throw s.error; return s ? s.snapshot : null; }",
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
        url: "data:text/javascript,export async function listPayBands() { return globalThis.__compensationOverview.bands; } export async function compaRatioFor() { return null; }",
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
        url: "data:text/javascript,export async function listJobLevels() { return globalThis.__compensationOverview.levels; } export async function compensationSettings() { return { comparisonAttributeKey: null, gapThresholdPct: '5', responseDays: null, fteRounding: 'up_to_whole', burdenRate: null }; }",
      };
    }
    if (owned && specifier === "@openbooks/engine/hrm/compensation") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export async function listJobFamilies() { return globalThis.__compensationOverview.families; } export async function listPayBandVersions() { return globalThis.__compensationOverview.versions; } export async function compensationWageSummary(input) { const value = globalThis.__compensationOverview; value.wageInput = input; if (value.error) throw value.error; return value.wages; }",
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
Object.assign(globalThis, { React });
const identity = { orgId: "019f655b-2900-7000-8000-000000000001", id: "019f655b-2900-7000-8000-000000000002" };
const authz = { user: identity, allowedSubsidiaryIds: null } as never;
const scopedAuthz = { user: identity, allowedSubsidiaryIds: new Set(["019f655b-2900-7000-8000-000000000003"]) } as never;

function overviewFixture(empty = false) {
  const value = {
    bands: empty ? [] : [{ id: "band" }],
    families: empty ? [] : [{ id: "family-a" }, { id: "family-b" }],
    levels: empty ? [] : [{ id: "level-a" }, { id: "level-b" }, { id: "level-c" }],
    versions: empty ? [] : [{ id: "version-a" }, { id: "version-b" }],
    wages: { asOf: "2026-09-22", workers: empty ? 0 : 7, covered: empty ? 0 : 5,
      missing: empty ? 0 : 1, ambiguous: empty ? 0 : 1,
      groups: empty ? [] : [{ basis: "hour", currency: "CAD", workers: 5, average: "34.5000", min: "34.5000", max: "34.5000" }] },
    error: null as Error | null,
    wageInput: null as unknown,
  };
  gap.__compensationOverview = value;
  gap.__compensationGapReads = 0;
  return value;
}

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
      thresholdPct: "5",
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
  const data = await loadEquity(scopedAuthz);
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

test("the architecture overview never requests a frozen aggregate unavailable to a scoped reader", async () => {
  const facts = overviewFixture();
  gap.__f17Gap = { error: new CompensationError("REFUSED", SCOPE_REFUSAL) };
  const data = await loadCompensationHome(scopedAuthz);
  assert.ok(data, "the home loader still resolves");
  assert.equal(gap.__compensationGapReads, 0, "the scoped architecture cockpit does not request an organization-wide frozen aggregate");
  assert.equal(data.refusal, null, "an unrelated aggregate refusal is not represented as a failed architecture read");
  assert.deepEqual(data.overview?.wages, facts.wages, "the overview retains authorized native wage facts");
  assert.deepEqual(facts.wageInput, { orgId: identity.orgId, actorId: identity.id }, "the native wage reader resolves scope from the attributable actor");
  assert.ok(data.tiles.every((tile) => tile.label !== "Joint assessment flags"), "the cockpit makes no unrequested equity claim");
});

test("the architecture overview preserves genuine empty native registers without inventing equity measurements", async () => {
  overviewFixture(true);
  gap.__f17Gap = { snapshot: null };
  const data = await loadCompensationHome(authz);
  assert.equal(data?.refusal, null, "absence is not a refusal");
  assert.deepEqual(data?.tiles.map((tile) => tile.value), ["0", "0", "0", "0"], "zero is supported by the empty worker, family, level and band registers");
  assert.deepEqual(data?.wageTiles, [], "no average is invented without a wage population");
  assert.equal(gap.__compensationGapReads, 0);
});

test("the architecture overview measures current wage and architecture facts independently of pay equity", async () => {
  overviewFixture();
  gap.__f17Gap = { snapshot: validSnapshot() };
  const data = await loadCompensationHome(authz);
  assert.equal(data?.refusal, null, "success carries no refusal");
  assert.deepEqual(data?.tiles.map((tile) => tile.value), ["7", "2", "3", "1"]);
  assert.equal(data?.overview?.bandVersions, 2, "effective-date history remains separate from the current band count");
  assert.equal(data?.wageTiles[0]?.value, "34.50 CAD", "actual wage basis and currency are retained without annualization or FX");
  assert.equal(data?.overview?.wages.missing, 1, "missing wages remain visible rather than becoming nil wages");
  assert.equal(data?.overview?.wages.ambiguous, 1, "overlapping wage facts remain visible rather than being guessed");
  assert.equal(gap.__compensationGapReads, 0);
});

test("the architecture overview raises refused or failed native wage reads instead of substituting zero", async () => {
  for (const error of [new Error("db went away"), new HrmAuthorizationError("Ask an administrator for compensation access to this employer.")]) {
    overviewFixture().error = error;
    await assert.rejects(loadCompensationHome(authz), (actual) => actual === error, "the exact native failure reaches the caller, never a zero-population summary");
  }
});

// The view specification forwards the full payload to the native workspace.
// Exercise that workspace's actual refusal branch, including suppression of
// aggregate rows and metrics, rather than assuming an older block layout.

function elementsOfType(node: ReactNode, type: unknown): React.ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap((child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return [];
    return [
      ...(child.type === type ? [child] : []),
      ...elementsOfType(child.props.children as ReactNode, type),
    ];
  });
}

test("the computed equity refusal reaches the native workspace and suppresses its metrics and table", async () => {
  const { equitySpec } = await import("./equity/view.ts");
  const { EquityWorkspace } = await import("./equity/EquityWorkspace");
  const { EmptyState } = await import("@openbooks/ui");
  const { RegisteredListTable } = await import("../../../../components/registered-list-table");
  const { KpiStrip } = await import("../../../../components/kpi-strip");
  gap.__f17Gap = { error: new CompensationError("REFUSED", SCOPE_REFUSAL) };
  const equity = await loadEquity(authz);
  assert.ok(equity);
  const spec = equitySpec(equity) as { body?: { widget?: string; props?: { data?: unknown } }[] };
  assert.equal(spec.body?.find((block) => block.widget === "hrm-comp-equity-workspace")?.props?.data, equity, "the spec forwards the complete refused data to its native renderer");
  const body = EquityWorkspace({ data: equity });
  const [banner] = elementsOfType(body, EmptyState);
  assert.ok(banner, "the real native workspace renders the refusal");
  assert.equal(banner.props.title, "Pay equity");
  assert.equal(banner.props.description, SCOPE_REFUSAL, "the actual rendered banner receives the full remedy");
  assert.deepEqual(elementsOfType(body, RegisteredListTable), [], "the refused workspace exposes no aggregate category rows");
  assert.deepEqual(elementsOfType(body, KpiStrip), [], "the refused workspace exposes no aggregate metric tiles");
});

test("genuine no-snapshot equity keeps its table distinct from a refusal", async () => {
  const { EquityWorkspace } = await import("./equity/EquityWorkspace");
  const { RegisteredListTable } = await import("../../../../components/registered-list-table");
  const { EmptyState } = await import("@openbooks/ui");
  gap.__f17Gap = { snapshot: null };
  const equity = await loadEquity(authz);
  assert.ok(equity);
  assert.equal(equity.hasContent, true, "genuine emptiness keeps content");
  const body = EquityWorkspace({ data: equity });
  const [categories] = elementsOfType(body, RegisteredListTable);
  assert.ok(categories, "the actual workspace retains the shared category register");
  assert.deepEqual(categories.props.rows, []);
  assert.equal(categories.props.source, "hrm_compensation_equity");
  const [empty] = elementsOfType(categories.props.empty as ReactNode, EmptyState);
  assert.equal(empty?.props.title, "No snapshot yet", "genuine absence retains its precise empty state, separate from an access refusal");
});
