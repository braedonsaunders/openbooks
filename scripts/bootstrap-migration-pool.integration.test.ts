/**
 * Bootstrap's schema migrations must not ride the request pool's 120s client
 * query_timeout: the whole-schema baseline builds hundreds of tables,
 * indexes, and constraints in ONE statement, and a slow host exceeds the
 * client timer ("Query read timeout") long before the server finishes.
 *
 * Proves the property directly: the executor bootstrap uses carries no
 * client cap, a deliberately slow statement completes through it, and the
 * same statement FAILS through a request-shaped pool — demonstrating the cap
 * was real and is gone from the migration path.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  connectMigrationClient,
  describeBootstrapMigrationFailure,
  releaseMigrationClient,
} from "./bootstrap-migration-client.ts";
import { env, longPool, pool } from "../engine/src/db.ts";

const DB = !!env.OPENBOOKS_DB_URL;

test("the migration pool carries no client cap while the request pool keeps its guard", () => {
  assert.equal(longPool.options.query_timeout, 0);
  assert.equal(longPool.options.statement_timeout, 0);
  // The fix moves the work; it must not delete the guard.
  assert.equal(pool.options.query_timeout, 120_000);
  assert.equal(pool.options.statement_timeout, 120_000);
});

test(
  "a slow statement completes through the migration client and fails through a request-shaped pool",
  { skip: !DB },
  async () => {
    const before = { total: longPool.totalCount, idle: longPool.idleCount };
    const client = await connectMigrationClient();
    // Provenance: the checkout must have come from longPool — either a new
    // session or one of its idle sessions — never from the request pool.
    assert.ok(
      longPool.totalCount === before.total + 1 || longPool.idleCount === before.idle - 1,
      "migration client must be checked out from longPool",
    );
    try {
      // Bypass parity with the old wrapped-pool path: migration backfills
      // must see every row.
      const gucs = await client.query<{ org: string; bypass: string }>(
        `select current_setting('app.current_org', true) as org,
                current_setting('app.bypass_rls', true) as bypass`,
      );
      assert.deepEqual(gucs.rows[0], { org: "", bypass: "on" });
      // Beyond the old 120s cap this would take two minutes; a 1.5s sleep
      // against a 0.5s-capped pool below proves the same mechanism.
      await client.query("select pg_sleep(1.5)");
    } finally {
      await releaseMigrationClient(client);
    }

    // The cap was real: the same slow statement through a request-shaped
    // pool dies with exactly the error operators saw on slow hosts.
    const capped = new pg.Pool({
      connectionString: env.OPENBOOKS_DB_URL,
      max: 1,
      connectionTimeoutMillis: 10_000,
      query_timeout: 500,
      statement_timeout: 500,
    });
    try {
      await assert.rejects(capped.query("select pg_sleep(1.5)"), /Query read timeout/);
    } finally {
      await capped.end();
    }
  },
);

test(
  "releasing a migration client restores the deny-by-default posture",
  { skip: !DB },
  async () => {
    const client = await connectMigrationClient();
    await releaseMigrationClient(client);
    // longPool now holds exactly the one idle session we just reset, so the
    // next checkout must reuse it — the posture check below is deterministic.
    assert.equal(longPool.totalCount, 1);
    assert.equal(longPool.idleCount, 1);
    const reused = await longPool.connect();
    try {
      const gucs = await reused.query<{ org: string | null; bypass: string | null }>(
        `select current_setting('app.current_org', true) as org,
                current_setting('app.bypass_rls', true) as bypass`,
      );
      assert.deepEqual(gucs.rows[0], { org: "", bypass: "off" });
    } finally {
      reused.release();
    }
  },
);

test("bootstrap routes its long DDL through the migration client, not the request pool", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "bootstrap.ts"), "utf8");
  // One chunk per top-level function; later short-statement helpers that
  // legitimately keep the request pool must not leak into these bodies.
  const chunks = source.split(/^(?=async function |function )/m);
  const bodyOf = (signature: string): string => {
    const chunk = chunks.find((entry) => entry.startsWith(signature));
    assert.ok(chunk, `${signature} not found in bootstrap.ts`);
    return chunk;
  };
  for (const [label, body] of [
    ["executeTrackedMigration", bodyOf("async function executeTrackedMigration(")],
    ["applyRowLevelSecurity", bodyOf("async function applyRowLevelSecurity(")],
  ] as const) {
    assert.ok(
      body.includes("connectMigrationClient()"),
      `${label} must execute long DDL through the timeout-free migration client`,
    );
    assert.ok(
      !body.includes("pool.connect()") && !body.includes("pool.query("),
      `${label} must not execute long DDL on the 120s request pool`,
    );
  }
});

test("a client-side timeout names the timer and the remedy", () => {
  const message = describeBootstrapMigrationFailure(
    "generated/0001_baseline.sql",
    new Error("Query read timeout"),
    121_000,
  );
  assert.ok(message.includes("generated/0001_baseline.sql"));
  assert.ok(message.includes("client-side") && message.includes("query_timeout"));
  assert.ok(message.includes("not a schema error"));
  assert.ok(message.includes("pg_stat_activity"));
});

test("a server-side statement timeout is reported as the server refusing", () => {
  const cancelled = new Error("canceling statement due to statement timeout") as Error & {
    code: string;
  };
  cancelled.code = "57014";
  const message = describeBootstrapMigrationFailure("environments.sql", cancelled, 30_000);
  assert.ok(message.includes("server-side") && message.includes("statement_timeout"));
  assert.ok(!message.includes("not a schema error"));
});

test("an ordinary failure still carries the file, the elapsed time, and the cause", () => {
  const message = describeBootstrapMigrationFailure(
    "generated/0002_kernel_hardening.sql",
    new Error("duplicate key value violates unique constraint"),
    4_200,
  );
  assert.equal(
    message,
    "[bootstrap] generated/0002_kernel_hardening.sql failed after 4.2s: "
      + "duplicate key value violates unique constraint",
  );
});
