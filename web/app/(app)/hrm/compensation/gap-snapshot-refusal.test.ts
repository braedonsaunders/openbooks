import assert from "node:assert/strict";
import test from "node:test";
import React, { Children, isValidElement, type ReactNode } from "react";

import { installCompensationReadFixture } from '../../../../testing/compensation-read-fixture';
const fixture = installCompensationReadFixture();

const { loadCompensationHome, loadEquity } = await import("../../../../lib/hrm/compensation.ts");
const { CompensationError } = await import(
  "@openbooks/engine/src/hrm/compensation/errors.ts"
);
const { HrmAuthorizationError } = await import("@openbooks/engine/src/hrm/authorization.ts");

Object.assign(globalThis, { React });
const identity = { orgId: "019f655b-2900-7000-8000-000000000001", id: "019f655b-2900-7000-8000-000000000002" };
const permissions = new Set(["hrm.compensation.read", "hrm.compensation.manage", "admin.setup.manage"]);
const authz = { user: identity, permissions, allowedSubsidiaryIds: null } as never;
const scopedAuthz = { user: identity, permissions, allowedSubsidiaryIds: new Set(["019f655b-2900-7000-8000-000000000003"]) } as never;

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
  fixture.overview = value;
  fixture.gapReads = 0;
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
  fixture.snapshot = { error: new CompensationError("REFUSED", SCOPE_REFUSAL) };
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
  fixture.snapshot = {
    error: new HrmAuthorizationError("compensation reads need the hrm.compensation.read grant in this organization."),
  };
  const data = await loadEquity(authz);
  assert.ok(data?.refusal, "the auth refusal travels as data");
  assert.match(data.refusal.message, /hrm\.compensation\.read/, "the missing grant is named");
});

test("equity keeps the genuine no-snapshot empty state", async () => {
  fixture.snapshot = { snapshot: null };
  const data = await loadEquity(authz);
  assert.ok(data, "the equity loader still resolves");
  assert.equal(data.hasSnapshot, false, "absence is still reported");
  assert.equal(data.refusal, null, "absence is not a refusal");
  assert.equal(data.hasContent, true, "genuine emptiness keeps its table");
  assert.equal(data.emptyTitle, "No snapshot yet", "the empty copy is preserved");
});

test("equity preserves a valid snapshot untouched", async () => {
  fixture.snapshot = { snapshot: validSnapshot() };
  const data = await loadEquity(authz);
  assert.equal(data?.hasSnapshot, true, "the snapshot is claimed");
  assert.equal(data?.refusal, null, "success carries no refusal");
  assert.equal(data?.hasContent, true, "a valid snapshot renders its grid and table");
  assert.equal(data?.tiles.length, 4, "all four metric tiles render");
  assert.equal(data?.tiles[3]?.value, "2", "both joint-assessment flags count");
  assert.equal(data?.categories.length, 2, "both categories render");
});

test("equity propagates an unexpected system failure instead of an empty page", async () => {
  fixture.snapshot = { error: new TypeError("connection terminated") };
  await assert.rejects(loadEquity(authz), /connection terminated/, "the failure reaches the caller, never a null snapshot");
});

test("the architecture overview never requests a frozen aggregate unavailable to a scoped reader", async () => {
  const facts = overviewFixture();
  fixture.snapshot = { error: new CompensationError("REFUSED", SCOPE_REFUSAL) };
  const data = await loadCompensationHome(scopedAuthz);
  assert.ok(data, "the home loader still resolves");
  assert.equal(fixture.gapReads, 0, "the scoped architecture cockpit does not request an organization-wide frozen aggregate");
  assert.equal(data.refusal, null, "an unrelated aggregate refusal is not represented as a failed architecture read");
  assert.deepEqual(data.overview?.wages, facts.wages, "the overview retains authorized native wage facts");
  assert.deepEqual(facts.wageInput, { orgId: identity.orgId, actorId: identity.id }, "the native wage reader resolves scope from the attributable actor");
  assert.ok(data.tiles.every((tile) => tile.label !== "Joint assessment flags"), "the cockpit makes no unrequested equity claim");
});

test("the architecture overview preserves genuine empty native registers without inventing equity measurements", async () => {
  overviewFixture(true);
  fixture.snapshot = { snapshot: null };
  const data = await loadCompensationHome(authz);
  assert.equal(data?.refusal, null, "absence is not a refusal");
  assert.deepEqual(data?.tiles.map((tile) => tile.value), ["0", "0", "0", "0"], "zero is supported by the empty worker, family, level and band registers");
  assert.deepEqual(data?.wageTiles, [], "no average is invented without a wage population");
  assert.equal(fixture.gapReads, 0);
});

test("the architecture overview measures current wage and architecture facts independently of pay equity", async () => {
  overviewFixture();
  fixture.snapshot = { snapshot: validSnapshot() };
  const data = await loadCompensationHome(authz);
  assert.equal(data?.refusal, null, "success carries no refusal");
  assert.deepEqual(data?.tiles.map((tile) => tile.value), ["7", "2", "3", "1"]);
  assert.equal(data?.overview?.bandVersions, 2, "effective-date history remains separate from the current band count");
  assert.equal(data?.wageTiles[0]?.value, "34.50 CAD", "actual wage basis and currency are retained without annualization or FX");
  assert.equal(data?.overview?.wages.missing, 1, "missing wages remain visible rather than becoming nil wages");
  assert.equal(data?.overview?.wages.ambiguous, 1, "overlapping wage facts remain visible rather than being guessed");
  assert.equal(fixture.gapReads, 0);
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
  fixture.snapshot = { error: new CompensationError("REFUSED", SCOPE_REFUSAL) };
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
  fixture.snapshot = { snapshot: null };
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
