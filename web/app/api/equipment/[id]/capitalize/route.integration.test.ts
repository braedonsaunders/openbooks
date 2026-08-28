import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Live-Postgres regression for equipment capitalization idempotency: both
// requests complete their pre-transaction reads while a holder pins the unit,
// then race for the same source row.  The route's row lock lets one create and
// link the asset; the loser returns the established 409 conflict, with no
// duplicate or orphaned fixed asset left behind.
const stateKey = Symbol.for("openbooks.equipment-capitalization-route-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: null;
  } | null;
  categoryId: string | null;
}
const routeState: RouteState = { authz: null, categoryId: null };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockFeatureGates = `
  const state = globalThis[Symbol.for('openbooks.equipment-capitalization-route-test')]
  export async function guardFeaturePermission(_permission, _featureKey) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
`;

const mockFeatures = `
  export async function isFeatureEnabled(_orgId, _key) { return true }
`;

const mockEnsure = `
  const state = globalThis[Symbol.for('openbooks.equipment-capitalization-route-test')]
  export async function ensureDefaultCategory(_orgId, _actorId) {
    if (!state.categoryId) throw new Error('test category is not seeded')
    return state.categoryId
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (
      specifier === "../../../../../lib/feature-gates"
      && context.parentURL?.includes("/api/equipment/")
    ) {
      return { url: "mock:equipment-feature-gates", shortCircuit: true };
    }
    if (
      specifier === "../../../../../lib/features"
      && context.parentURL?.includes("/api/equipment/")
    ) {
      return { url: "mock:equipment-features", shortCircuit: true };
    }
    if (
      specifier === "../../../assets/categories/_ensure"
      && context.parentURL?.includes("/api/equipment/")
    ) {
      return { url: "mock:equipment-category", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:equipment-feature-gates") {
      return { format: "module", source: mockFeatureGates, shortCircuit: true };
    }
    if (url === "mock:equipment-features") {
      return { format: "module", source: mockFeatures, shortCircuit: true };
    }
    if (url === "mock:equipment-category") {
      return { format: "module", source: mockEnsure, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?equipment-capitalization-concurrency-test";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db, pool } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/test-fixtures.ts",
);
const { Client } = await import("pg");
type ScratchOrg = Awaited<ReturnType<typeof createScratchOrg>>;
const DB = !!process.env.OPENBOOKS_DB_URL;

interface Fixture {
  org: ScratchOrg;
  actorId: string;
  categoryId: string;
  equipmentId: string;
}

async function seed(): Promise<Fixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const categoryId = randomUUID();
  await db.execute(sql`
    insert into asset_categories
      (id, org_id, name, asset_account_id, accumulated_depreciation_account_id,
       depreciation_expense_account_id, default_method, default_life_months,
       default_convention, tax_attributes, is_active, created_by, updated_by)
    values (${categoryId}, ${org.orgId}, 'Equipment test', ${org.accounts.invAsset},
            ${org.accounts.clearing}, ${org.accounts.cogs}, 'straight_line', 60,
            'full_month', '{}'::jsonb, true, ${actorId}, ${actorId})`);
  const equipmentId = randomUUID();
  await db.execute(sql`
    insert into equipment_units
      (id, org_id, subsidiary_id, unit_number, name, status, purchase_price,
       acquired_on, in_service_on, serial_number)
    values (${equipmentId}, ${org.orgId}, ${org.subsidiaryId}, ${`EQ-${equipmentId.slice(0, 8)}`},
            'Concurrent excavator', 'active', '75000', ${org.date}, ${org.date}, 'SN-0068')`);
  routeState.categoryId = categoryId;
  routeState.authz = {
    user: { orgId: org.orgId, id: actorId },
    permissions: new Set(["*"]),
    allowedSubsidiaryIds: null,
  };
  return { org, actorId, categoryId, equipmentId };
}

async function holdEquipmentRow(fixture: Fixture): Promise<InstanceType<typeof Client>> {
  const holder = new Client({ connectionString: process.env.OPENBOOKS_DB_URL });
  await holder.connect();
  await holder.query("begin");
  await holder.query(
    "select set_config('app.current_org', $1, true), set_config('app.bypass_rls', 'on', true)",
    [fixture.org.orgId],
  );
  await holder.query(
    "select id from equipment_units where id = $1 and org_id = $2 for update",
    [fixture.equipmentId, fixture.org.orgId],
  );
  return holder;
}

function post(fixture: Fixture): Promise<Response> {
  routeState.authz = {
    user: { orgId: fixture.org.orgId, id: fixture.actorId },
    permissions: new Set(["*"]),
    allowedSubsidiaryIds: null,
  };
  return POST(
    new Request(`http://openbooks.test/api/equipment/${fixture.equipmentId}/capitalize`, {
      method: "POST",
    }),
    { params: Promise.resolve({ id: fixture.equipmentId }) },
  );
}

async function waitForRouteWaiters(fixture: Fixture): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const waiters = await pool.query<{ n: number }>(
      `select count(*)::int as n
         from pg_stat_activity
        where datname = current_database()
          and wait_event_type = 'Lock'
          and query ilike '%from equipment_units%'
          and query ilike '%for update%'`,
    );
    if ((waiters.rows[0]?.n ?? 0) >= 2) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for both capitalization requests on ${fixture.equipmentId}`);
}

test(
  "concurrent capitalization creates one linked asset and returns a controlled conflict",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    const holder = await holdEquipmentRow(fixture);
    let holderOpen = true;
    try {
      const requests = [post(fixture), post(fixture)];
      await waitForRouteWaiters(fixture);
      await holder.query("commit");
      holderOpen = false;
      const responses = await Promise.all(requests);
      assert.deepEqual(
        responses.map((response) => response.status).sort((left, right) => left - right),
        [200, 409],
        "one request must create the asset and the loser must receive a conflict, never a 500",
      );

      const winner = responses.find((response) => response.status === 200)!;
      const winnerBody = (await winner.json()) as { assetId: string; assetNumber: string };
      assert.match(winnerBody.assetNumber, /^FA-\d+$/);
      const loser = responses.find((response) => response.status === 409)!;
      assert.deepEqual(await loser.json(), { error: "already_capitalized" });

      const state = await db.execute<{
        fixed_asset_id: string | null;
        asset_count: number;
        orphan_count: number;
      }>(sql`
        select
          (select fixed_asset_id from equipment_units where id = ${fixture.equipmentId}) as fixed_asset_id,
          (select count(*)::int from fixed_assets where org_id = ${fixture.org.orgId}) as asset_count,
          (select count(*)::int
             from fixed_assets fa
            where fa.org_id = ${fixture.org.orgId}
              and not exists (
                select 1 from equipment_units eu
                 where eu.org_id = fa.org_id and eu.fixed_asset_id = fa.id
              )) as orphan_count`);
      assert.equal(state.rows[0]?.fixed_asset_id, winnerBody.assetId, "the winner's id remains linked");
      assert.equal(state.rows[0]?.asset_count, 1, "the race must not duplicate the fixed asset");
      assert.equal(state.rows[0]?.orphan_count, 0, "the losing transaction must not leave an orphan");
    } finally {
      if (holderOpen) await holder.query("rollback").catch(() => undefined);
      await holder.end();
      // dropScratchOrg clears fixed_assets in its generic pass before the
      // equipment_units core pass.  Remove this linked fixture first so the
      // FK can be satisfied without weakening the production schema.
      await db.execute(sql`
        delete from equipment_units
         where id = ${fixture.equipmentId} and org_id = ${fixture.org.orgId}`);
      routeState.authz = null;
      routeState.categoryId = null;
      await dropScratchOrg(fixture.org.orgId);
    }
  },
);
