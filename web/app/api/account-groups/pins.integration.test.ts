import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Live-Postgres regression for the account-group pin race.  Migration 0081
// owns one account/dimension row at storage, while the route's transaction
// advisory fence makes concurrent moves linearizable instead of allowing two
// delete-then-insert requests to leave sibling pins behind.
const stateKey = Symbol.for("openbooks.account-group-pins-route-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions?: Set<string>;
    allowedSubsidiaryIds?: Set<string> | null;
  } | null;
}
const routeState: RouteState = { authz: null };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const module_ = (source: string): { shortCircuit: true; format: "module"; url: string } => ({
  shortCircuit: true,
  format: "module",
  url: `data:text/javascript,${encodeURIComponent(source)}`,
});

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    // Re-export the REAL authz module and override only the session gate, so
    // the account-subsidiary guards the route calls are the production
    // functions. Gates without an explicit scope default to unrestricted.
    if (specifier === "../../../../../lib/authz") {
      const real = nextResolve(specifier, context).url;
      const nextServer = nextResolve("next/server", context).url;
      return module_(`
        export * from ${JSON.stringify(real)};
        const state = globalThis[Symbol.for('openbooks.account-group-pins-route-test')];
        const { NextResponse } = await import(${JSON.stringify(nextServer)});
        export async function guardPermission(_permission) {
          if (!state.authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
          return { permissions: new Set(), allowedSubsidiaryIds: null, ...state.authz };
        }
      `);
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      return nextResolve(new URL(`../../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context);
    }
    return nextResolve(specifier, context);
  },
});

const routeUrl = new URL("./[id]/pins/route.ts?account-group-pins-test", import.meta.url).href;
const { POST, DELETE } = (await import(routeUrl)) as typeof import("./[id]/pins/route.ts");
hooks.deregister();

const { db, pool } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrgReporting, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

function errorChain(error: unknown): string {
  const cause = (error as { cause?: unknown }).cause;
  return `${String(error)}\n${cause === undefined ? "" : String(cause)}`;
}

async function seed(): Promise<{
  orgId: string;
  actorId: string;
  accountId: string;
  groupA: string;
  groupB: string;
}> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const groupA = randomUUID();
  const groupB = randomUUID();
  await db.execute(sql`
    insert into account_groups (id, org_id, dimension, key, name, sort_order, match, is_catch_all, is_active, created_by)
    values
      (${groupA}, ${org.orgId}, 'test_dimension', 'group_a', 'Group A', 1, '{}'::jsonb, false, true, ${actorId}),
      (${groupB}, ${org.orgId}, 'test_dimension', 'group_b', 'Group B', 2, '{}'::jsonb, false, true, ${actorId})`);
  return { orgId: org.orgId, actorId, accountId: org.accounts.cogs, groupA, groupB };
}

function post(fixture: Awaited<ReturnType<typeof seed>>, groupId: string): Promise<Response> {
  routeState.authz = { user: { orgId: fixture.orgId, id: fixture.actorId } };
  return POST(
    new Request(`http://openbooks.test/api/account-groups/${groupId}/pins`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: fixture.accountId }),
    }),
    { params: Promise.resolve({ id: groupId }) },
  );
}

async function waitForAdvisoryWaiter(): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const result = await pool.query<{ n: number }>(
      `select count(*)::int as n
         from pg_stat_activity
        where datname = current_database()
          and wait_event_type = 'Lock'
          and query ilike '%pg_advisory_xact_lock%'`,
    );
    if ((result.rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for account-group pin advisory lock");
}

test(
  "account-group pins are unique in storage and concurrent route moves leave one deterministic winner",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fixture = await seed();
    try {
      const index = await db.execute<{ indexdef: string }>(sql`
        select indexdef from pg_indexes
         where schemaname = 'public'
           and indexname = 'account_group_members_org_dimension_account'`);
      assert.match(index.rows[0]?.indexdef ?? "", /org_id.*dimension.*account_id/);

      await db.execute(sql`
        insert into account_group_members (org_id, group_id, account_id, dimension, created_by)
        values (${fixture.orgId}, ${fixture.groupA}, ${fixture.accountId}, 'test_dimension', ${fixture.actorId})`);
      await assert.rejects(
        db.execute(sql`
          insert into account_group_members (org_id, group_id, account_id, dimension, created_by)
          values (${fixture.orgId}, ${fixture.groupB}, ${fixture.accountId}, 'test_dimension', ${fixture.actorId})`),
        (error: unknown) => /account_group_members_org_dimension_account|duplicate key value violates unique constraint/.test(errorChain(error)),
      );
      await db.execute(sql`
        delete from account_group_members
         where org_id = ${fixture.orgId} and account_id = ${fixture.accountId}`);

      const lockKey = `account-group-pin:${fixture.orgId}:test_dimension:${fixture.accountId}`;
      const holder = await pool.connect();
      let holderOpen = true;
      try {
        await holder.query("begin");
        await holder.query("select set_config('app.bypass_rls', 'on', true)");
        await holder.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);

        const first = post(fixture, fixture.groupA);
        const second = post(fixture, fixture.groupB);
        await waitForAdvisoryWaiter();
        await holder.query("commit");
        holderOpen = false;

        const responses = await Promise.all([first, second]);
        assert.deepEqual(responses.map((response) => response.status), [200, 200]);
        const rows = await db.execute<{ group_id: string; n: number }>(sql`
          select group_id, count(*) over ()::int as n
            from account_group_members
           where org_id = ${fixture.orgId}
             and dimension = 'test_dimension'
             and account_id = ${fixture.accountId}`);
        assert.equal(rows.rows.length, 1, "concurrent moves must leave one pin");
        assert.equal(rows.rows[0]?.n, 1);
        assert.ok(
          rows.rows[0]?.group_id === fixture.groupA || rows.rows[0]?.group_id === fixture.groupB,
          "the surviving pin must be one of the requested groups",
        );
      } finally {
        if (holderOpen) await holder.query("rollback").catch(() => undefined);
        holder.release();
      }
    } finally {
      await dropScratchOrgReporting(fixture.orgId);
    }
  },
);

test(
  "account-group pins refuse out-of-scope and shared-chart accounts to restricted callers",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const groupId = randomUUID();
    await db.execute(sql`
      insert into account_groups (id, org_id, dimension, key, name, sort_order, match, is_catch_all, is_active, created_by)
      values (${groupId}, ${org.orgId}, 'scope_dimension', 'scope_group', 'Scope Group', 1, '{}'::jsonb, false, true, ${actorId})`);
    const entityB = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      values (${entityB}, ${org.orgId}, ${org.subsidiaryId}, 'Entity B', 'CAD', 'CA')`);
    const seedAccount = async (number: string, subsidiaryId: string | null) => {
      const id = randomUUID();
      await db.execute(sql`
        insert into accounts (id, org_id, number, name, type, subsidiary_id)
        values (${id}, ${org.orgId}, ${number}, ${`Pin scope ${number}`}, 'asset_other', ${subsidiaryId})`);
      return id;
    };
    // The scratch subsidiary id is not exposed by this fixture file's seed;
    // resolve the org root (the caller's own entity) directly.
    const root = await db.execute<{ id: string }>(sql`
      select id from subsidiaries where org_id = ${org.orgId} and parent_id is null limit 1`);
    const entityA = root.rows[0]!.id;
    const accountA = await seedAccount('9201', entityA);
    const accountB = await seedAccount('9202', entityB);
    const sharedAccount = await seedAccount('9203', null);
    try {
      const scopeA = new Set([entityA]);
      const pin = (accountId: string, scope: Set<string> | null) => {
        routeState.authz = { user: { orgId: org.orgId, id: actorId }, allowedSubsidiaryIds: scope };
        return POST(
          new Request(`http://openbooks.test/api/account-groups/${groupId}/pins`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ accountId }),
          }),
          { params: Promise.resolve({ id: groupId }) },
        );
      };
      const unpin = (accountId: string, scope: Set<string> | null) => {
        routeState.authz = { user: { orgId: org.orgId, id: actorId }, allowedSubsidiaryIds: scope };
        return DELETE(
          new Request(`http://openbooks.test/api/account-groups/${groupId}/pins?accountId=${accountId}`, {
            method: 'DELETE',
          }),
          { params: Promise.resolve({ id: groupId }) },
        );
      };
      const deniedB = await pin(accountB, scopeA);
      assert.equal(deniedB.status, 404);
      assert.deepEqual(await deniedB.json(), { error: 'not found' });
      const deniedShared = await pin(sharedAccount, scopeA);
      assert.equal(deniedShared.status, 403);
      assert.deepEqual(await deniedShared.json(), { error: 'requires unrestricted subsidiary access' });
      const allowed = await pin(accountA, scopeA);
      assert.equal(allowed.status, 200);
      const members = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from account_group_members
         where org_id = ${org.orgId} and group_id = ${groupId} and account_id = ${accountA}`);
      assert.equal(members.rows[0]?.n ?? -1, 1, 'the in-scope pin persists');
      const refused = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from account_group_members
         where org_id = ${org.orgId} and group_id = ${groupId} and account_id in (${accountB}, ${sharedAccount})`);
      assert.equal(refused.rows[0]?.n ?? -1, 0, 'refused pins store nothing');
      // Unpinning follows the same account-subsidiary rule on both verbs.
      assert.equal((await unpin(accountB, scopeA)).status, 404);
      assert.equal((await unpin(sharedAccount, scopeA)).status, 403);
      assert.equal((await unpin(accountA, scopeA)).status, 200);
      const remaining = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from account_group_members
         where org_id = ${org.orgId} and group_id = ${groupId} and account_id = ${accountA}`);
      assert.equal(remaining.rows[0]?.n ?? -1, 0, 'the in-scope unpin removes the pin');
    } finally {
      routeState.authz = null;
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
