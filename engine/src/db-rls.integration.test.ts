import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { sql } from "drizzle-orm";
import { db, env, withBypass, withBypassContext } from "./db.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!env.OPENBOOKS_DB_URL;
const RUNTIME_DB = process.env.OPENBOOKS_RUNTIME_DB_URL;

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

  // And the deny-by-default posture is still intact outside any scope — but
  // only where there IS a default to deny. The trusted-test harness
  // (test-database-bypass.ts, loaded by `npm test`) exists precisely to turn
  // bypass on globally, so under it an unscoped read legitimately sees every
  // org. Asserting 0 there tests the harness, not the posture.
  if (!process.env.OPENBOOKS_TRUSTED_TEST_BYPASS) {
    const unscoped = (await db.execute<{ n: number }>(
      sql`select count(*)::int as n from orgs`,
    ));
    assert.equal(Number(unscoped.rows[0]!.n), 0);
  }
});
