import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import type { Client } from "pg";

// The POST and PATCH writers must keep a referenced GL account in its
// authorized scope through persistence, even when the preflight sees A and
// the account is rehomed to B before the write transaction acquires its lock.
const stateKey = Symbol.for("openbooks.asset-account-override-rehome-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    allowedSubsidiaryIds: Set<string> | null;
  } | null;
}
const routeState: RouteState = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockFeatureGates = `
  const state = globalThis[Symbol.for('openbooks.asset-account-override-rehome-test')]
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
      const parentDir = decodeURIComponent(new URL(".", context.parentURL).href);
      const webRoot = parentDir.lastIndexOf("/web/");
      if (webRoot === -1) return nextResolve(specifier, context);
      return nextResolve(new URL(parentDir.slice(0, webRoot + 5) + specifier.slice(2) + ".ts").href, context);
    }
    if (specifier.endsWith("/lib/feature-gates") && context.parentURL?.includes("/api/assets/")) {
      return { url: "mock:asset-account-override-feature-gates", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:asset-account-override-feature-gates") {
      return { format: "module", source: mockFeatureGates, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { POST } = (await import("./route.ts")) as typeof import("./route.ts");
const { PATCH } = (await import("./[id]/route.ts")) as typeof import("./[id]/route.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { documentRevisionSql } = await import("@openbooks/engine/src/records/revision.ts");
const { createScratchOrg, dropScratchOrgReporting, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts",
);
const DB = !!process.env.OPENBOOKS_DB_URL;

interface Fixture {
  orgId: string;
  actorId: string;
  subsidiaryA: string;
  subsidiaryB: string;
  accountId: string;
  categoryId: string;
  assetId: string;
  date: string;
}

async function seedFixture(): Promise<Fixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const subsidiaryB = randomUUID();
  const accountId = randomUUID();
  const categoryId = randomUUID();
  const assetId = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, is_active)
    values (${subsidiaryB}, ${org.orgId}, ${org.subsidiaryId}, 'Override rehome target', 'CAD', 'CA', true)`);
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, subsidiary_id, is_active, is_summary)
    values (${accountId}, ${org.orgId}, 'ASSET-OVERRIDE-RACE', 'Rehome race account', 'asset_fixed', ${org.subsidiaryId}, true, false)`);
  await db.execute(sql`
    insert into asset_categories
      (id, org_id, name, asset_account_id, accumulated_depreciation_account_id,
       depreciation_expense_account_id, default_method, default_life_months,
       default_convention, tax_attributes, is_active)
    values (${categoryId}, ${org.orgId}, 'Override race category', ${org.accounts.invAsset},
            ${org.accounts.clearing}, ${org.accounts.adjustment}, 'straight_line', 12,
            'full_month', '{}'::jsonb, true)`);
  await db.execute(sql`
    insert into fixed_assets
      (id, org_id, subsidiary_id, category_id, asset_number, name, status,
       acquired_on, acquisition_cost, salvage_value, depreciation_method,
       useful_life_months, custom)
    values (${assetId}, ${org.orgId}, ${org.subsidiaryId}, ${categoryId}, 'OVERRIDE-RACE-ASSET',
            'Override race asset', 'draft', ${org.date}, '100.0000', '0.0000',
            'straight_line', 12, '{}'::jsonb)`);
  routeState.authz = {
    user: { orgId: org.orgId, id: actorId },
    allowedSubsidiaryIds: new Set([org.subsidiaryId]),
  };
  return {
    orgId: org.orgId,
    actorId,
    subsidiaryA: org.subsidiaryId,
    subsidiaryB,
    accountId,
    categoryId,
    assetId,
    date: org.date,
  };
}

async function holdAndRehomeAccount(fixture: Fixture): Promise<Client> {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.OPENBOOKS_DB_URL });
  await client.connect();
  await client.query("begin");
  await client.query(
    "select set_config('app.current_org', $1, true), set_config('app.bypass_rls', 'on', true)",
    [fixture.orgId],
  );
  await client.query("select id from accounts where org_id = $1 and id = $2 for update", [fixture.orgId, fixture.accountId]);
  await client.query("update accounts set subsidiary_id = $1 where org_id = $2 and id = $3", [fixture.subsidiaryB, fixture.orgId, fixture.accountId]);
  return client;
}

async function waitForAccountShare(settled: () => boolean): Promise<void> {
  for (let waited = 0; waited < 15_000; waited += 25) {
    if (settled()) assert.fail("the asset write completed before waiting for the account row lock");
    const blocked = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_stat_activity
       where datname = current_database() and pid <> pg_backend_pid()
         and wait_event_type = 'Lock'
         and query ilike '%from accounts a%'
         and query ilike '%for share of a%'`);
    if (blocked.rows[0]?.n) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("timed out waiting for asset writer to lock the referenced account");
}

const writers = ["POST create", "PATCH edit"] as const;
for (const writer of writers) {
  test(`asset ${writer} refuses an account rehomed after preflight`, { skip: !DB }, async () => {
    const fixture = await seedFixture();
    let holder: Client | undefined;
    try {
      holder = await holdAndRehomeAccount(fixture);
      let settled = false;
      const write = writer === "POST create"
        ? POST(new Request("http://openbooks.test/api/assets", {
            method: "POST",
            headers: { "content-type": "application/json", "Idempotency-Key": randomUUID() },
            body: JSON.stringify({
              name: "New asset",
              categoryId: fixture.categoryId,
              subsidiaryId: fixture.subsidiaryA,
              acquisitionCost: "100.0000",
              salvageValue: "0.0000",
              acquiredOn: fixture.date,
              assetAccountId: fixture.accountId,
            }),
          }))
        : PATCH(new Request(`http://openbooks.test/api/assets/${fixture.assetId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              expectedUpdatedAt: (await db.execute<{ revision: string }>(sql`
                select ${documentRevisionSql(sql`updated_at`)} as revision
                  from fixed_assets where org_id = ${fixture.orgId} and id = ${fixture.assetId}`)).rows[0]!.revision,
              assetAccountId: fixture.accountId,
            }),
          }), { params: Promise.resolve({ id: fixture.assetId }) });
      const pending = write.finally(() => { settled = true; });
      await waitForAccountShare(() => settled);
      await holder.query("commit");
      await holder.end();
      holder = undefined;
      const response = await pending;
      assert.equal(response.status, 422, JSON.stringify(await response.clone().json()));
      assert.equal(
        (await response.json()).error,
        writer === "POST create" ? "invalid_asset_account" : "Invalid asset account",
      );
      const stored = await db.execute<{ asset_account_id: string | null }>(sql`
        select asset_account_id from fixed_assets where org_id = ${fixture.orgId} and id = ${fixture.assetId}`);
      assert.equal(stored.rows[0]?.asset_account_id ?? null, null, "the hidden account must not be stored");
      if (writer === "POST create") {
        const created = await db.execute<{ n: number }>(sql`
          select count(*)::int as n from fixed_assets
           where org_id = ${fixture.orgId} and asset_account_id = ${fixture.accountId}`);
        assert.equal(created.rows[0]?.n ?? 0, 0);
      }
    } finally {
      if (holder) {
        await holder.query("rollback");
        await holder.end();
      }
      await dropScratchOrgReporting(fixture.orgId);
    }
  });
}
