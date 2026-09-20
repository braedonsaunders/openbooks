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
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockFeatureGates = `
  const state = globalThis[Symbol.for('openbooks.asset-opening-route-test')]
  export async function guardFeaturePermission() {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      return nextResolve(new URL(`../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context);
    }
    if (
      specifier === "../../../../lib/feature-gates" &&
      context.parentURL?.includes("/api/assets/")
    ) {
      return { url: "mock:asset-opening-feature-gates", shortCircuit: true };
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
const {
  FIXED_ASSET_BASE_JOINS,
  FIXED_ASSET_BUILT_IN_EXPR,
} = await import("../../../../lib/customization/entity-list-query/fixed-assets.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { documentRevisionSql } = await import("@openbooks/engine/src/records/revision.ts");
const { buildSchedule, runDepreciation } = await import("@openbooks/engine/src/assets/depreciation.ts");
const { createScratchOrg, dropScratchOrgReporting, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

const DB = !!process.env.OPENBOOKS_DB_URL;

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
}

async function seedFixture(): Promise<Fixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const cal = (await db.execute<{ id: string }>(sql`
    select fiscal_calendar_id as id from accounting_periods where org_id = ${org.orgId} limit 1`)).rows[0]!.id;
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
  return { orgId: org.orgId, actorId, assetId };
}

async function revisionOf(assetId: string): Promise<string> {
  return (await db.execute<{ revision: string }>(sql`
    select ${documentRevisionSql(sql`updated_at`)} as revision from fixed_assets where id = ${assetId}`)).rows[0]!.revision;
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
  asset: { opening_accumulated_depreciation: string | null; opening_accumulated_as_of: string | null };
  totals: { accumulated: string; netBookValue: string };
  schedule: { plannedAmount: string }[];
}

async function getPayload(fixture: Fixture): Promise<{ status: number; body: OpeningDrawerPayload }> {
  routeState.authz = {
    user: { orgId: fixture.orgId, id: fixture.actorId },
    allowedSubsidiaryIds: null,
  };
  const response = await GET(new Request(`http://openbooks.test/api/assets/${fixture.assetId}`), {
    params: Promise.resolve({ id: fixture.assetId }),
  });
  return { status: response.status, body: (await response.json()) as OpeningDrawerPayload };
}

test("PATCH places a mid-life asset in service with opening figures and the drawer ties out", { skip: !DB }, async () => {
  const fixture = await seedFixture();
  try {
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
    assert.equal(response.status, 200, `PATCH must accept the opening figures (${await response.clone().text().then((t) => t.slice(0, 200))})`);
    const saved = (await response.json()) as OpeningDrawerPayload;
    assert.equal(saved.asset.opening_accumulated_depreciation, "55000.0000");
    assert.equal(String(saved.asset.opening_accumulated_as_of).slice(0, 10), "2025-12-31");
    assert.equal(saved.totals.accumulated, "55000.0000", "drawer accumulated carries the opening figure");
    assert.equal(saved.totals.netBookValue, "65000.0000", "drawer NBV nets the opening figure");
    assert.equal(
      saved.schedule[0]?.plannedAmount,
      "1000.0000",
      `first scheduled month is a single month, not a catch-up (got ${saved.schedule[0]?.plannedAmount})`,
    );

    const fetched = await getPayload(fixture);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.totals.accumulated, "55000.0000");
    assert.equal(fetched.body.totals.netBookValue, "65000.0000");
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(fixture.orgId);
  }
});

test("PATCH refuses half-set, excessive, and post-history opening edits", { skip: !DB }, async () => {
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
    const bookId = (await db.execute<{ id: string }>(sql`
      select id from accounting_books where org_id = ${fixture.orgId} and is_primary limit 1`)).rows[0]!.id;
    await buildSchedule(fixture.assetId, fixture.orgId, fixture.actorId, bookId);
    const run = await runDepreciation(fixture.orgId, "2026-01-31", fixture.actorId, fixture.assetId);
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

test("the register list reads NBV as cost minus opening minus posted", { skip: !DB }, async () => {
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
    const bookId = (await db.execute<{ id: string }>(sql`
      select id from accounting_books where org_id = ${fixture.orgId} and is_primary limit 1`)).rows[0]!.id;
    await buildSchedule(fixture.assetId, fixture.orgId, fixture.actorId, bookId);
    const run = await runDepreciation(fixture.orgId, "2026-03-31", fixture.actorId, fixture.assetId);
    assert.equal(run.totalAmount, "3000.0000");

    const rows = (await db.execute<{ accumulated: string; nbv: string }>(sql`
      select ${FIXED_ASSET_BUILT_IN_EXPR.accumulated} as accumulated,
             ${FIXED_ASSET_BUILT_IN_EXPR.net_book_value} as nbv
        from fixed_assets a
        ${FIXED_ASSET_BASE_JOINS}
       where a.org_id = ${fixture.orgId} and a.id = ${fixture.assetId}`)).rows;
    assert.equal(rows[0]?.accumulated, "58000.0000", "register accumulated = opening 55000 + posted 3000");
    assert.equal(rows[0]?.nbv, "62000.0000", "register NBV = cost − opening − posted");
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(fixture.orgId);
  }
});
