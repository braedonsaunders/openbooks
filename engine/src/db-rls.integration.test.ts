import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { sql } from "drizzle-orm";
import {
  db,
  env,
  longPool,
  withBypass,
  withBypassContext,
  withMaintenanceTransaction,
  withOrg,
} from "./db.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!env.OPENBOOKS_DB_URL;
const RUNTIME_DB = process.env.OPENBOOKS_RUNTIME_DB_URL;

test("tenant transactions remain isolated from saturated maintenance capacity", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  const originalName = await withBypassContext(async () => {
    const result = await db.execute<{ name: string }>(
      sql`select name from orgs where id = ${org.orgId}`,
    );
    return result.rows[0]!.name;
  });
  const maintenanceClients = await Promise.all(
    Array.from({ length: 4 }, () => longPool.connect()),
  );
  const releaseMaintenanceClients = () => {
    for (const client of maintenanceClients.splice(0)) client.release();
  };

  try {
    const tenantAttempt = withOrg(org.orgId, async () => {
      const gucs = await db.execute<{ org: string; bypass: string }>(sql`
        select current_setting('app.current_org', true) as org,
               current_setting('app.bypass_rls', true) as bypass
      `);
      assert.deepEqual(gucs.rows[0], { org: org.orgId, bypass: "off" });

      await withOrg(org.orgId, () =>
        db.execute(sql`update orgs set name = 'must roll back' where id = ${org.orgId}`),
      );
      await assert.rejects(
        withOrg("00000000-0000-0000-0000-000000000000", async () => {}),
        /cannot change organization inside an active tenant transaction/,
      );
      throw new Error("rollback sentinel");
    });

    const tenantMaintenanceWaiters = longPool.waitingCount;
    if (tenantMaintenanceWaiters !== 0) {
      // Settle the accidentally queued transaction before failing so this test
      // never leaves a waiter or relies on the pool's 30-second timeout.
      releaseMaintenanceClients();
      await tenantAttempt.catch(() => {});
    }
    assert.equal(
      tenantMaintenanceWaiters,
      0,
      "a normal tenant transaction queued behind the saturated maintenance pool",
    );
    await assert.rejects(tenantAttempt, /rollback sentinel/);

    const afterRollback = await withBypassContext(() =>
      db.execute<{ name: string }>(sql`select name from orgs where id = ${org.orgId}`),
    );
    assert.equal(afterRollback.rows[0]!.name, originalName);

    const maintenanceAttempt = withMaintenanceTransaction(org.orgId, async () => {
      const gucs = await db.execute<{ org: string; bypass: string }>(
        sql`select current_setting('app.current_org', true) as org,
                   current_setting('app.bypass_rls', true) as bypass`,
      );
      assert.deepEqual(gucs.rows[0], { org: org.orgId, bypass: "off" });
    });
    assert.equal(
      longPool.waitingCount,
      1,
      "the explicit maintenance transaction did not queue on the maintenance pool",
    );
    maintenanceClients.shift()!.release();
    await maintenanceAttempt;
  } finally {
    releaseMaintenanceClients();
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("database access without an explicit organization context fails closed", { skip: !DB || !RUNTIME_DB }, async () => {
  const first = await withBypass(() => createScratchOrg());
  const second = await withBypass(() => createScratchOrg());
  const client = new pg.Client({ connectionString: RUNTIME_DB });
  try {
    await client.connect();
    await client.query(
      "select set_config('app.current_org', '', false), set_config('app.bypass_rls', 'off', false)",
    );
    const unscoped = await client.query<{ id: string }>(
      "select id from orgs where id = any($1::uuid[])",
      [[first.orgId, second.orgId]],
    );
    assert.deepEqual(unscoped.rows, []);

    await client.query(
      "select set_config('app.current_org', $1, false), set_config('app.bypass_rls', 'off', false)",
      [first.orgId],
    );
    const firstScoped = await client.query<{ id: string }>(
      "select id from orgs where id = any($1::uuid[])",
      [[first.orgId, second.orgId]],
    );
    assert.deepEqual(firstScoped.rows, [{ id: first.orgId }]);

    await client.query(
      "select set_config('app.current_org', '', false), set_config('app.bypass_rls', 'on', false)",
    );
    const explicitlyPrivileged = await client.query<{ id: string }>(
      "select id from orgs where id = any($1::uuid[]) order by id",
      [[first.orgId, second.orgId]],
    );
    assert.deepEqual(
      explicitlyPrivileged.rows.map((row) => row.id),
      [first.orgId, second.orgId].sort(),
    );
  } finally {
    await client.end().catch(() => {});
    await withBypass(() => dropScratchOrg(second.orgId));
    await withBypass(() => dropScratchOrg(first.orgId));
  }
});

/**
 * End-to-end companion to engine/src/db-org-context.test.ts.
 *
 * The context-only helpers set no GUCs themselves: the pooled-query wrapper
 * reads the AsyncLocalStorage context when the query actually executes. A
 * drizzle builder is a lazy thenable, so a scope that ends when the callback
 * RETURNS rather than when its work COMPLETES leaves the query to run
 * unscoped — deny-by-default, zero rows, no error. This asserts the real pool
 * path against a real database, in the exact call shape that was broken.
 *
 * Read-only: it counts what is already there and never writes.
 */
test("withBypassContext actually reaches the database with bypass", { skip: !DB }, async () => {
  // env, not process.env: db.ts resolves the connection string from the
  // repo-root .env as well, and this must be the SAME database the pool uses.
  const privileged = new pg.Client({ connectionString: env.OPENBOOKS_DB_URL });
  await privileged.connect();
  let expected: number;
  try {
    await privileged.query("select set_config('app.bypass_rls', 'on', false)");
    const counted = await privileged.query<{ n: number }>("select count(*)::int as n from orgs");
    expected = Number(counted.rows[0]!.n);
  } finally {
    await privileged.end().catch(() => {});
  }
  // Anti-vacuous-pass guard: comparing 0 against 0 is exactly the failure this
  // test exists to catch, so an empty database makes the check inconclusive
  // rather than green.
  assert.ok(expected > 0, "no orgs present — this assertion cannot distinguish bypass from denial");

  // The call shape that silently returned zero rows: the callback hands back
  // drizzle's un-started thenable instead of awaiting it.
  const viaHelper = (await withBypassContext(() =>
    db.execute(sql`select count(*)::int as n from orgs`),
  )) as unknown as { rows: { n: number }[] };
  assert.equal(
    Number(viaHelper.rows[0]!.n),
    expected,
    "withBypassContext did not carry bypass to the pool — org-spanning reads are silently empty",
  );

  // The scope must also be observable at the mechanism level, not just through
  // one row count: inside withBypassContext the pooled statement carries the
  // bypass GUCs (the pool wrapper applies them on the checked-out client
  // immediately before each statement, so current_setting reflects exactly
  // what this query ran with).
  const scopedGucs = await withBypassContext(() =>
    db.execute<{ org: string; bypass: string }>(
      sql`select current_setting('app.current_org', true) as org,
                 current_setting('app.bypass_rls', true) as bypass`,
    ),
  );
  assert.deepEqual(
    { org: scopedGucs.rows[0]!.org, bypass: scopedGucs.rows[0]!.bypass },
    { org: "", bypass: "on" },
    "withBypassContext did not apply the bypass GUCs to its pooled statements",
  );

  // Outside any scope the posture is deny-by-default — but "deny" is a
  // property of the database ROLE, not of the GUCs alone. The trusted-test
  // harness (test-database-bypass.ts, loaded by `npm test`) turns bypass on
  // globally, so under it an unscoped read legitimately sees every org and
  // asserting anything about rows would test the harness, not the posture.
  if (!process.env.OPENBOOKS_TRUSTED_TEST_BYPASS) {
    // With no context anywhere, the wrapper must bracket every pooled
    // statement with the fail-closed GUCs.
    const unscopedGucs = await db.execute<{ org: string; bypass: string }>(
      sql`select current_setting('app.current_org', true) as org,
                 current_setting('app.bypass_rls', true) as bypass`,
    );
    assert.deepEqual(
      { org: unscopedGucs.rows[0]!.org, bypass: unscopedGucs.rows[0]!.bypass },
      { org: "", bypass: "off" },
      "an unscoped pooled query did not apply the deny-by-default GUCs",
    );

    // An unscoped read must never see MORE than an explicitly denied session
    // on the same connection string. The old assertion here demanded zero
    // rows outright, which is unsatisfiable rather than protective: the pool
    // connects with OPENBOOKS_DB_URL, and in CI and local development that is
    // the bootstrap role (the service container's POSTGRES_USER), which
    // PostgreSQL exempts from row security even under FORCE ROW LEVEL
    // SECURITY — superuser and BYPASSRLS sessions ignore every policy, so no
    // set_config combination can show them fewer rows. On a constrained
    // runtime role (production traffic, openbooks_app in CI) the denied count
    // is zero and this is that original end-to-end proof; on an exempt role
    // both counts equal the full table by server semantics, and production is
    // kept honest separately: bootstrap provisions openbooks_app as
    // NOSUPERUSER/NOBYPASSRLS and assertSafeRuntimeDatabaseRole refuses to
    // start a production process on any role that could bypass tenant RLS.
    const denied = new pg.Client({ connectionString: env.OPENBOOKS_DB_URL });
    await denied.connect();
    let deniedCount: number;
    try {
      await denied.query(
        "select set_config('app.current_org', '', false), set_config('app.bypass_rls', 'off', false)",
      );
      const counted = await denied.query<{ n: number }>("select count(*)::int as n from orgs");
      deniedCount = Number(counted.rows[0]!.n);
    } finally {
      await denied.end().catch(() => {});
    }
    const unscoped = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from orgs`,
    );
    assert.equal(
      Number(unscoped.rows[0]!.n),
      deniedCount,
      "an unscoped pooled read saw more than an explicitly denied session on the same role",
    );
  }
});
