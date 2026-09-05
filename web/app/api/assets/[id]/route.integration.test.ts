import { documentRevisionSql } from '@openbooks/engine/src/document-revision.ts';
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import type { Client } from "pg";

// Live-Postgres regression for fnd_mtcbagp3_y0gebx: an asset PATCH used to
// decide posted-basis immutability before opening its transaction. A posting
// could then commit while the PATCH waited on its UPDATE, and the stale basis
// change would commit after it. The route now locks and reloads fixed_assets
// inside the transaction, so the loser rechecks posted history and rolls back.

const stateKey = Symbol.for("openbooks.asset-route-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    allowedSubsidiaryIds: null;
  } | null;
}
const routeState: RouteState = { authz: null };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockFeatureGates = `
  const state = globalThis[Symbol.for('openbooks.asset-route-test')]
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
      return { url: "mock:asset-feature-gates", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:asset-feature-gates") {
      return { format: "module", source: mockFeatureGates, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?asset-basis-posting-race-test";
const { PATCH } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/db.ts");
const { buildSchedule } = await import("@openbooks/engine/src/depreciation.ts");
const { createScratchOrg, dropScratchOrgReporting, seedFlowActors } = await import(
  "@openbooks/engine/src/test-fixtures.ts",
);

const DB = !!process.env.OPENBOOKS_DB_URL;

interface Fixture {
  orgId: string;
  actorId: string;
  assetId: string;
  scheduleLineId: string;
}

async function seedAsset(): Promise<Fixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const categoryId = randomUUID();
  const assetId = randomUUID();

  await db.execute(sql`
    insert into asset_categories
      (id, org_id, name, asset_account_id, accumulated_depreciation_account_id,
       depreciation_expense_account_id, default_method, default_life_months,
       default_convention, tax_attributes, is_active)
    values (${categoryId}, ${org.orgId}, 'Race-test equipment', ${org.accounts.invAsset},
            ${org.accounts.clearing}, ${org.accounts.adjustment}, 'straight_line', 12,
            'full_month', '{}'::jsonb, true)`);
  await db.execute(sql`
    insert into fixed_assets
      (id, org_id, subsidiary_id, category_id, asset_number, name, status,
       acquired_on, in_service_on, acquisition_cost, salvage_value,
       depreciation_method, useful_life_months, custom)
    values (${assetId}, ${org.orgId}, ${org.subsidiaryId}, ${categoryId}, 'RACE-ASSET',
            'Race-test asset', 'in_service', ${org.date}, ${org.date}, '12000.0000',
            '2000.0000', 'straight_line', 12, '{}'::jsonb)`);

  await buildSchedule(assetId, org.orgId, actorId, org.bookId);
  const line = await db.execute<{ id: string }>(sql`
    select l.id
      from depreciation_schedule_lines l
      join depreciation_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
     where l.org_id = ${org.orgId} and s.asset_id = ${assetId}
     order by l.sequence
     limit 1`);
  assert.ok(line.rows[0], "the fixture must have a schedule line to post");
  return { orgId: org.orgId, actorId, assetId, scheduleLineId: line.rows[0]!.id };
}

async function openAssetHolder(fixture: Fixture): Promise<Client> {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.OPENBOOKS_DB_URL });
  await client.connect();
  await client.query("begin");
  await client.query(
    "select set_config('app.current_org', $1, true), set_config('app.bypass_rls', 'on', true)",
    [fixture.orgId],
  );
  await client.query(
    "select id from fixed_assets where org_id = $1 and id = $2 for update",
    [fixture.orgId, fixture.assetId],
  );
  return client;
}

async function patchRequest(fixture: Fixture, body: Record<string, unknown>): Promise<Request> {
  routeState.authz = {
    user: { orgId: fixture.orgId, id: fixture.actorId },
    allowedSubsidiaryIds: null,
  };
  return new Request(`http://openbooks.test/api/assets/${fixture.assetId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, expectedUpdatedAt: (await db.execute<{revision:string}>(sql`select ${documentRevisionSql(sql`updated_at`)} as revision from fixed_assets where id=${fixture.assetId}`)).rows[0]!.revision }),
  });
}

async function waitForAssetLock(settled: () => boolean): Promise<void> {
  for (let waited = 0; waited < 15_000; waited += 25) {
    if (settled()) assert.fail("the PATCH completed before the asset lock was observed");
    const blocked = await db.execute<{ n: number }>(sql`
      select count(*)::int as n
        from pg_stat_activity
       where datname = current_database()
         and pid <> pg_backend_pid()
         and wait_event_type = 'Lock'
         and query ilike '%from fixed_assets%'
         and query ilike '%for update%'`);
    if ((blocked.rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("timed out waiting for the asset PATCH to park on fixed_assets");
}

test(
  "asset basis PATCH rechecks posted depreciation after waiting for the asset lock",
  { skip: !DB },
  async () => {
    const fixture = await seedAsset();
    let holder: Client | null = null;
    try {
      holder = await openAssetHolder(fixture);
      let settled = false;
      const pending = PATCH(await patchRequest(fixture, { acquisitionCost: "13000" }), {
        params: Promise.resolve({ id: fixture.assetId }),
      }).then(async (response) => {
        settled = true;
        return { status: response.status, body: (await response.json()) as { error?: string } };
      });

      await waitForAssetLock(() => settled);

      // A runner-shaped transaction posts the line while the PATCH is queued
      // behind the authoritative fixed_assets row lock. Imported is used only
      // to satisfy the schedule-line posting-evidence constraint without
      // manufacturing a journal entry; the route guard treats every posted
      // line as immutable history regardless of source.
      await holder.query(
        `update depreciation_schedule_lines
            set source = 'imported', posted_amount = '100.0000'
          where org_id = $1 and id = $2`,
        [fixture.orgId, fixture.scheduleLineId],
      );
      await holder.query("commit");
      await holder.end();
      holder = null;

      const result = await pending;
      assert.equal(result.status, 409);
      assert.match(result.body.error ?? "", /depreciation basis.*fixed/i);

      const state = await db.execute<{ acquisition_cost: string; audits: number }>(sql`
        select a.acquisition_cost::text,
               (select count(*)::int from audit_log l
                 where l.org_id = a.org_id and l.table_name = 'fixed_assets' and l.row_id = a.id) as audits
          from fixed_assets a
         where a.org_id = ${fixture.orgId} and a.id = ${fixture.assetId}`);
      assert.equal(state.rows[0]?.acquisition_cost, "12000.0000");
      assert.equal(state.rows[0]?.audits, 0, "the refused stale save must leave no audit row");
    } finally {
      if (holder) {
        await holder.query("rollback").catch(() => undefined);
        await holder.end().catch(() => undefined);
      }
      routeState.authz = null;
      await dropScratchOrgReporting(fixture.orgId);
    }
  },
);

test(
  "asset basis PATCH still commits and audits before depreciation posts",
  { skip: !DB },
  async () => {
    const fixture = await seedAsset();
    try {
      const response = await PATCH(await patchRequest(fixture, { acquisitionCost: "13000" }), {
        params: Promise.resolve({ id: fixture.assetId }),
      });
      assert.equal(response.status, 200, `save failed: ${JSON.stringify(await response.json())}`);

      const state = await db.execute<{ acquisition_cost: string; audits: number }>(sql`
        select a.acquisition_cost::text,
               (select count(*)::int from audit_log l
                 where l.org_id = a.org_id and l.table_name = 'fixed_assets' and l.row_id = a.id) as audits
          from fixed_assets a
         where a.org_id = ${fixture.orgId} and a.id = ${fixture.assetId}`);
      assert.equal(state.rows[0]?.acquisition_cost, "13000.0000");
      assert.equal(state.rows[0]?.audits, 1);
    } finally {
      routeState.authz = null;
      await dropScratchOrgReporting(fixture.orgId);
    }
  },
);
