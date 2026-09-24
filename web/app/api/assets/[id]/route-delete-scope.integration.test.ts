import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Asset DELETE rechecks the scope AND the draft status under the asset row
// lock inside the delete transaction: the unlocked precheck can authorize an
// A asset while a concurrent A→B rehome lands before the schedule, event
// and asset deletes commit. Out-of-scope answers exactly like missing, and a
// refused delete keeps every row.

const stateKey = Symbol.for("openbooks.asset-delete-scope-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    allowedSubsidiaryIds: Set<string> | null;
  } | null;
}
const routeState: RouteState = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockFeatureGates = `
  const state = globalThis[Symbol.for('openbooks.asset-delete-scope-test')]
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
      return { url: "mock:asset-delete-scope-feature-gates", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:asset-delete-scope-feature-gates") {
      return { format: "module", source: mockFeatureGates, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?asset-delete-scope-test";
const { DELETE } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db, pool } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrgReporting, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

const DB = !!process.env.OPENBOOKS_DB_URL;

interface Fixture {
  orgId: string;
  subsidiaryA: string;
  hidden: string;
  assetA: string;
  assetB: string;
}

async function seedScopedAssets(): Promise<Fixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const hidden = randomUUID();
  await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden entity','CAD','CA')`);
  const categoryId = randomUUID();
  await db.execute(sql`
    insert into asset_categories
      (id, org_id, name, asset_account_id, accumulated_depreciation_account_id,
       depreciation_expense_account_id, gain_loss_account_id, default_method,
       default_life_months, default_convention, tax_attributes, is_active)
    values (${categoryId}, ${org.orgId}, 'Scope equipment', ${org.accounts.invAsset},
            ${org.accounts.clearing}, ${org.accounts.adjustment}, ${org.accounts.adjustment},
            'straight_line', 12, 'full_month', '{}'::jsonb, true)`);
  const asset = async (tag: string, subsidiaryId: string) => {
    const assetId = randomUUID();
    await db.execute(sql`
      insert into fixed_assets
        (id, org_id, subsidiary_id, category_id, asset_number, name, status,
         acquired_on, in_service_on, acquisition_cost, salvage_value,
         depreciation_method, useful_life_months, custom)
      values (${assetId}, ${org.orgId}, ${subsidiaryId}, ${categoryId}, ${tag},
              'Scope asset', 'draft', ${org.date}, ${org.date}, '12000.0000',
              '2000.0000', 'straight_line', 12, '{}'::jsonb)`);
    return assetId;
  };
  const assetA = await asset("SCOPE-A-DEL", org.subsidiaryId);
  const assetB = await asset("SCOPE-B-DEL", hidden);
  routeState.authz = {
    user: { orgId: org.orgId, id: actorId },
    allowedSubsidiaryIds: new Set([org.subsidiaryId]),
  };
  return { orgId: org.orgId, subsidiaryA: org.subsidiaryId, hidden, assetA, assetB };
}

async function assetCount(orgId: string, assetId: string): Promise<number> {
  return (await db.execute<{ n: number }>(
    sql`select count(*)::int as n from fixed_assets where org_id = ${orgId} and id = ${assetId}`,
  )).rows[0]!.n;
}

const deleteCall = (assetId: string) =>
  DELETE(new Request(`http://openbooks.test/api/assets/${assetId}`, { method: "DELETE" }), {
    params: Promise.resolve({ id: assetId }),
  });

test(
  "asset DELETE refuses an out-of-scope draft and deletes an in-scope one",
  { skip: !DB },
  async () => {
    const fixture = await seedScopedAssets();
    try {
      const refused = await deleteCall(fixture.assetB);
      assert.equal(refused.status, 404, JSON.stringify(await refused.clone().json()));
      assert.equal(await assetCount(fixture.orgId, fixture.assetB), 1, "the refused delete must keep the asset");

      const deleted = await deleteCall(fixture.assetA);
      assert.equal(deleted.status, 200, JSON.stringify(await deleted.clone().json()));
      assert.equal(await assetCount(fixture.orgId, fixture.assetA), 0, "the in-scope draft must be gone");
    } finally {
      routeState.authz = null;
      await dropScratchOrgReporting(fixture.orgId);
    }
  },
);

test(
  "asset DELETE waits on an asset rehome in flight instead of racing it",
  { skip: !DB },
  async () => {
    const fixture = await seedScopedAssets();
    const writer = await pool.connect();
    let pending: Promise<Response> | undefined;
    try {
      await writer.query("begin");
      await writer.query("select set_config('app.bypass_rls','on',true), set_config('statement_timeout','10000',true)");
      const pid = (await writer.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
      await writer.query("update fixed_assets set subsidiary_id=$1 where id=$2", [fixture.hidden, fixture.assetA]);
      pending = deleteCall(fixture.assetA);
      let blocked = false;
      for (let n = 0; n < 200; n++) {
        blocked = !!((await pool.query("select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))", [pid])).rowCount);
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(blocked, "the delete waits on the locked asset instead of deleting the pre-rehome row");
      await writer.query("commit");
      const response = await pending;
      assert.equal(response.status, 404, JSON.stringify(await response.clone().json()));
      assert.equal(await assetCount(fixture.orgId, fixture.assetA), 1, "the delete refused after the rehome keeps the asset");
    } finally {
      await writer.query("rollback").catch(() => {});
      await pending?.catch(() => {});
      writer.release();
      routeState.authz = null;
      await dropScratchOrgReporting(fixture.orgId);
    }
  },
);
