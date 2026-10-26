import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Mid-life onboarding through the asset flyout API: PATCH accepts the opening
// carry-in figures, the drawer payload ties out (accumulated carries the
// opening figure, NBV nets it, the first scheduled month is a single month),
// the register list reads the same NBV, and later edits fail closed.

const stateKey = Symbol.for("openbooks.asset-opening-route-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    allowedSubsidiaryIds: null;
  } | null;
}
const routeState: RouteState = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockFeatureGates = `
  const state = globalThis[Symbol.for('openbooks.asset-opening-route-test')]
  export async function guardFeaturePermission() {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier === "../../../../lib/feature-gates" &&
        context.parentURL?.includes("/api/assets/")) ||
      (specifier === "@/lib/feature-gates" && context.parentURL?.includes("/lib/api/route"))
    ) {
      return { url: "mock:asset-opening-feature-gates", shortCircuit: true };
    }
    // The flyout labels schedule periods in the viewer's locale.
    if (specifier === "next-intl/server") {
      return {
        url: "data:text/javascript,export async function getLocale(){return 'en'};export async function getTranslations(){return (key)=>key}",
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:asset-opening-feature-gates") {
      return { format: "module", source: mockFeatureGates, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?asset-opening-test";
const { PATCH, GET } = (await import(routeUrl)) as typeof import("./route.ts");
const { FIXED_ASSET_BASE_JOINS, FIXED_ASSET_BUILT_IN_EXPR } =
  await import("../../../../lib/customization/entity-list-query/fixed-assets.ts");

const { db } = await import("@openbooks/engine/platform/db");
const { documentRevisionSql } = await import("@openbooks/engine/records/revision");
const { buildSchedule, runDepreciation } = await import("@openbooks/engine/assets/depreciation");
const { createScratchOrg, dropScratchOrgReporting, seedFlowActors } =
  await import("@openbooks/engine/testing/fixtures");

const MONTHS_2026 = [
  { n: 1, name: "2026-01", from: "2026-01-01", to: "2026-01-31" },
  { n: 2, name: "2026-02", from: "2026-02-01", to: "2026-02-28" },
  { n: 3, name: "2026-03", from: "2026-03-01", to: "2026-03-31" },
  { n: 4, name: "2026-04", from: "2026-04-01", to: "2026-04-30" },
  { n: 5, name: "2026-05", from: "2026-05-01", to: "2026-05-31" },
  { n: 6, name: "2026-06", from: "2026-06-01", to: "2026-06-30" },
  { n: 8, name: "2026-08", from: "2026-08-01", to: "2026-08-31" },
  { n: 9, name: "2026-09", from: "2026-09-01", to: "2026-09-30" },
  { n: 10, name: "2026-10", from: "2026-10-01", to: "2026-10-31" },
  { n: 11, name: "2026-11", from: "2026-11-01", to: "2026-11-30" },
  { n: 12, name: "2026-12", from: "2026-12-01", to: "2026-12-31" },
];

interface Fixture {
  orgId: string;
  actorId: string;
  assetId: string;
  categoryId: string;
}

async function seedFixture(): Promise<Fixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const cal = (
    await db.execute<{ id: string }>(
      sql`
    select fiscal_calendar_id as id from accounting_periods where org_id = ${org.orgId} limit 1`,
      "objects",
    )
  )[0]!.id;
  for (const m of MONTHS_2026) {
    await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      values (${randomUUID()}, ${org.orgId}, 2026, ${m.n}, ${m.name}, ${m.from}, ${m.to}, false, ${cal})`);
  }
  const categoryId = randomUUID();
  const assetId = randomUUID();
  await db.execute(sql`
    insert into asset_categories
      (id, org_id, name, asset_account_id, accumulated_depreciation_account_id,
       depreciation_expense_account_id, default_method, default_life_months,
       default_convention, tax_attributes, is_active)
    values (${categoryId}, ${org.orgId}, 'Opening equipment', ${org.accounts.invAsset},
            ${org.accounts.clearing}, ${org.accounts.adjustment}, 'straight_line', 120,
            'full_month', '{}'::jsonb, true)`);
  await db.execute(sql`
    insert into fixed_assets
      (id, org_id, subsidiary_id, category_id, asset_number, name, status,
       acquisition_cost, salvage_value, custom)
    values (${assetId}, ${org.orgId}, ${org.subsidiaryId}, ${categoryId}, 'OPEN-1',
            'Onboarded asset', 'draft', '0', '0', '{}'::jsonb)`);
  return { orgId: org.orgId, actorId, assetId, categoryId };
}

async function revisionOf(assetId: string): Promise<string> {
  return (
    await db.execute<{ revision: string }>(
      sql`
    select ${documentRevisionSql(sql`updated_at`)} as revision from fixed_assets where id = ${assetId}`,
      "objects",
    )
  )[0]!.revision;
}

async function patchRequest(fixture: Fixture, body: Record<string, unknown>): Promise<Request> {
  routeState.authz = {
    user: { orgId: fixture.orgId, id: fixture.actorId },
    allowedSubsidiaryIds: null,
  };
  return new Request(`http://openbooks.test/api/assets/${fixture.assetId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, expectedUpdatedAt: await revisionOf(fixture.assetId) }),
  });
}

interface OpeningDrawerPayload {
  asset: {
    opening_accumulated_depreciation: string | null;
    opening_accumulated_as_of: string | null;
  };
  totals: { accumulated: string; netBookValue: string };
  schedule: { plannedAmount: string; periodName: string }[];
  scheduleBuild?: { scheduleId: string; lineCount: number; skippedMonths: string[] }[];
}

async function getPayload(
  fixture: Fixture,
  query?: string,
): Promise<{ status: number; body: OpeningDrawerPayload }> {
  routeState.authz = {
    user: { orgId: fixture.orgId, id: fixture.actorId },
    allowedSubsidiaryIds: null,
  };
  const search = query === undefined ? "" : `?q=${encodeURIComponent(query)}`;
  const response = await GET(
    new Request(`http://openbooks.test/api/assets/${fixture.assetId}${search}`),
    {
      params: Promise.resolve({ id: fixture.assetId }),
    },
  );
  return { status: response.status, body: (await response.json()) as OpeningDrawerPayload };
}

test("PATCH places a mid-life asset in service with opening figures and the drawer ties out", async () => {
  const fixture = await seedFixture();
  try {
    const journalBefore = await db.execute(
      sql`select id from journal_entries where org_id=${fixture.orgId} order by id`,
      "objects",
    );
    const response = await PATCH(
      await patchRequest(fixture, {
        acquisitionCost: "120000",
        inServiceOn: "2021-06-15",
        method: "straight_line",
        lifeMonths: 120,
        openingAccumulated: "55000",
        openingAsOf: "2025-12-31",
        status: "in_service",
      }),
      { params: Promise.resolve({ id: fixture.assetId }) },
    );
    assert.equal(
      response.status,
      200,
      `PATCH must accept the opening figures (${await response
        .clone()
        .text()
        .then((t) => t.slice(0, 200))})`,
    );
    const saved = (await response.json()) as OpeningDrawerPayload;
    assert.equal(saved.scheduleBuild?.length, 1);
    const build = saved.scheduleBuild![0]!;
    assert.ok(build.scheduleId);
    assert.equal(build.skippedMonths.length, 53);
    assert.equal(build.skippedMonths[0], "2027-01-01");
    assert.equal(build.skippedMonths.at(-1), "2031-05-01");
    assert.equal(
      (
        await db.execute(
          sql`select count(*)::int as n from depreciation_schedule_lines where org_id=${fixture.orgId} and schedule_id=${build.scheduleId}`,
          "objects",
        )
      )[0]!.n,
      build.lineCount,
    );
    assert.deepEqual(
      await db.execute(
        sql`select id from journal_entries where org_id=${fixture.orgId} order by id`,
        "objects",
      ),
      journalBefore,
      "placement builds metadata without a journal entry",
    );
    assert.equal(saved.asset.opening_accumulated_depreciation, "55000.0000");
    assert.equal(String(saved.asset.opening_accumulated_as_of).slice(0, 10), "2025-12-31");
    assert.equal(
      saved.totals.accumulated,
      "55000.0000",
      "drawer accumulated carries the opening figure",
    );
    assert.equal(saved.totals.netBookValue, "65000.0000", "drawer NBV nets the opening figure");
    assert.equal(
      saved.schedule[0]?.plannedAmount,
      "1000.0000",
      `first scheduled month is a single month, not a catch-up (got ${saved.schedule[0]?.plannedAmount})`,
    );

    // The saved payload names the period by its canonical fiscal label; the
    // flyout read labels it in the viewer's locale.
    assert.equal(saved.schedule[0]?.periodName, "P01 FY2026");

    const fetched = await getPayload(fixture);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.totals.accumulated, "55000.0000");
    assert.equal(fetched.body.totals.netBookValue, "65000.0000");
    assert.equal(fetched.body.schedule[0]?.periodName, "P01 FY2026 · Jan 2026");

    // Schedule search matches the label shown and the period's stored name.
    for (const query of ["Jan 2026", "P01 FY2026", "2026-01"]) {
      const found = await getPayload(fixture, query);
      assert.equal(found.status, 200);
      assert.deepEqual(
        found.body.schedule.map((line) => line.periodName),
        ["P01 FY2026 · Jan 2026"],
        `schedule search for ${query}`,
      );
    }
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(fixture.orgId);
  }
});

test("PATCH refuses half-set, excessive, and post-history opening edits", async () => {
  const fixture = await seedFixture();
  try {
    const half = await PATCH(await patchRequest(fixture, { openingAccumulated: "1000" }), {
      params: Promise.resolve({ id: fixture.assetId }),
    });
    assert.equal(half.status, 422);
    assert.match(((await half.json()) as { error: string }).error, /together/);

    const excessive = await PATCH(
      await patchRequest(fixture, {
        acquisitionCost: "120000",
        inServiceOn: "2021-06-15",
        method: "straight_line",
        lifeMonths: 120,
        openingAccumulated: "200000",
        openingAsOf: "2025-12-31",
      }),
      { params: Promise.resolve({ id: fixture.assetId }) },
    );
    assert.equal(excessive.status, 422);
    assert.match(((await excessive.json()) as { error: string }).error, /exceed/);

    // Place in service with a valid opening, post one period, then move the
    // opening figure: the posted basis is fixed.
    const placed = await PATCH(
      await patchRequest(fixture, {
        acquisitionCost: "120000",
        inServiceOn: "2021-06-15",
        method: "straight_line",
        lifeMonths: 120,
        openingAccumulated: "55000",
        openingAsOf: "2025-12-31",
        status: "in_service",
      }),
      { params: Promise.resolve({ id: fixture.assetId }) },
    );
    assert.equal(placed.status, 200);
    const bookId = (
      await db.execute<{ id: string }>(
        sql`
      select id from accounting_books where org_id = ${fixture.orgId} and is_primary limit 1`,
        "objects",
      )
    )[0]!.id;
    await buildSchedule(fixture.assetId, fixture.orgId, fixture.actorId, bookId);
    const run = await runDepreciation(
      fixture.orgId,
      "2026-01-31",
      fixture.actorId,
      fixture.assetId,
    );
    assert.equal(run.posted, 1);

    const moved = await PATCH(
      await patchRequest(fixture, { openingAccumulated: "56000", openingAsOf: "2025-12-31" }),
      { params: Promise.resolve({ id: fixture.assetId }) },
    );
    assert.equal(moved.status, 409);
    assert.match(((await moved.json()) as { error: string }).error, /basis.*fixed/i);
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(fixture.orgId);
  }
});

test("the register list reads NBV as cost minus opening minus posted", async () => {
  const fixture = await seedFixture();
  try {
    const placed = await PATCH(
      await patchRequest(fixture, {
        acquisitionCost: "120000",
        inServiceOn: "2021-06-15",
        method: "straight_line",
        lifeMonths: 120,
        openingAccumulated: "55000",
        openingAsOf: "2025-12-31",
        status: "in_service",
      }),
      { params: Promise.resolve({ id: fixture.assetId }) },
    );
    assert.equal(placed.status, 200);
    const bookId = (
      await db.execute<{ id: string }>(
        sql`
      select id from accounting_books where org_id = ${fixture.orgId} and is_primary limit 1`,
        "objects",
      )
    )[0]!.id;
    await buildSchedule(fixture.assetId, fixture.orgId, fixture.actorId, bookId);
    const run = await runDepreciation(
      fixture.orgId,
      "2026-03-31",
      fixture.actorId,
      fixture.assetId,
    );
    assert.equal(run.totalAmount, "3000.0000");

    const rows = await db.execute<{ accumulated: string; nbv: string }>(
      sql`
      select ${FIXED_ASSET_BUILT_IN_EXPR.accumulated} as accumulated,
             ${FIXED_ASSET_BUILT_IN_EXPR.net_book_value} as nbv
        from fixed_assets a
        ${FIXED_ASSET_BASE_JOINS}
       where a.org_id = ${fixture.orgId} and a.id = ${fixture.assetId}`,
      "objects",
    );
    assert.equal(
      rows[0]?.accumulated,
      "58000.0000",
      "register accumulated = opening 55000 + posted 3000",
    );
    assert.equal(rows[0]?.nbv, "62000.0000", "register NBV = cost − opening − posted");
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(fixture.orgId);
  }
});

interface PlacementPayload {
  asset: { status: string };
  placement: { missing: string[] };
  schedule: { plannedAmount: string }[];
}

test("a complete draft is placed in service by the status-only action and continues from its opening figures", async () => {
  const fixture = await seedFixture();
  try {
    const saved = await PATCH(
      await patchRequest(fixture, {
        acquisitionCost: "120000",
        inServiceOn: "2021-06-15",
        method: "straight_line",
        lifeMonths: 120,
        openingAccumulated: "55000",
        openingAsOf: "2025-12-31",
      }),
      { params: Promise.resolve({ id: fixture.assetId }) },
    );
    assert.equal(saved.status, 200, "a draft save with complete fields must succeed");
    const draft = (await saved.json()) as PlacementPayload;
    assert.equal(draft.asset.status, "draft");
    assert.deepEqual(draft.placement.missing, [], "a complete draft reports nothing missing");
    assert.equal(
      draft.schedule.length,
      0,
      "a draft owns no schedule until it is placed in service",
    );

    const placed = await PATCH(await patchRequest(fixture, { status: "in_service" }), {
      params: Promise.resolve({ id: fixture.assetId }),
    });
    assert.equal(placed.status, 200, "the status-only placement must succeed for a complete draft");
    const after = (await placed.json()) as PlacementPayload;
    assert.equal(after.asset.status, "in_service");
    assert.equal(
      after.schedule[0]?.plannedAmount,
      "1000.0000",
      "placement continues from the opening as-of date without re-posting pre-cutover months",
    );
    assert.deepEqual(after.placement.missing, []);
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(fixture.orgId);
  }
});

test("placement refuses a draft naming exactly the fields still missing and leaves it a draft", async () => {
  const fixture = await seedFixture();
  try {
    // With the category default life cleared, the asset itself must carry a life.
    await db.execute(sql`
      update asset_categories set default_life_months = null where id = ${fixture.categoryId}`);
    const draftSave = await PATCH(
      await patchRequest(fixture, {
        acquisitionCost: "120000",
        inServiceOn: "2021-06-15",
        method: "straight_line",
      }),
      { params: Promise.resolve({ id: fixture.assetId }) },
    );
    assert.equal(draftSave.status, 200);

    const before = (await getPayload(fixture)).body as unknown as PlacementPayload;
    assert.deepEqual(before.placement.missing, ["useful_life_months"]);

    const refused = await PATCH(await patchRequest(fixture, { status: "in_service" }), {
      params: Promise.resolve({ id: fixture.assetId }),
    });
    assert.equal(refused.status, 422);
    const refusal = (await refused.json()) as { error: string; code: string; missing: string[] };
    assert.equal(refusal.code, "asset_placement_incomplete");
    assert.deepEqual(refusal.missing, ["useful_life_months"], "only the missing life is named");
    assert.match(refusal.error, /Useful life \(months\)/);
    assert.doesNotMatch(refusal.error, /Cost|In service|Opening/, "set fields must not be named");

    const still = (await getPayload(fixture)).body as unknown as PlacementPayload;
    assert.equal(still.asset.status, "draft", "a refused placement leaves the asset a draft");
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(fixture.orgId);
  }
});

// Release the route doubles after every test in this file has run.
test.after(() => hooks.deregister());
