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
  executeMigrationAttempt,
  executeMigrationBody,
  isLockNotAvailable,
  migrationLockConfig,
  migrationRunsWithoutTransaction,
  releaseMigrationClient,
  sanitizeMigrationContent,
} from "./bootstrap-migration-client.ts";
import { env, longPool, pool } from "../engine/src/platform/db.ts";

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

    // The cap was real: the same slow statement through a request-shaped pool
    // is refused by the CLIENT timer — "Query read timeout", the string
    // operators actually reported from slow hosts.
    //
    // The server cap is deliberately widened to 5s here so only the client
    // timer can fire. The request pool arms both at the same value in
    // production, which makes WHICH one wins a race against host speed; an
    // assertion that tolerates either would still pass if the client-side
    // mechanism broke entirely and the server cancelled instead. Removing the
    // race is therefore stronger than tolerating it. The server-side path has
    // its own test below.
    const capped = new pg.Pool({
      connectionString: env.OPENBOOKS_DB_URL,
      max: 1,
      connectionTimeoutMillis: 10_000,
      query_timeout: 500,
      statement_timeout: 5_000,
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

test("executeTrackedMigration bounds the lock wait, retries 55P03, and honors no-transaction files", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "bootstrap.ts"), "utf8");
  const chunks = source.split(/^(?=async function |function )/m);
  const body = chunks.find((entry) => entry.startsWith("async function executeTrackedMigration("));
  assert.ok(body, "executeTrackedMigration not found in bootstrap.ts");
  // The bound must be imposed by the runner every attempt, not trusted from
  // the file: a file-level SET would silently disarm it for later statements.
  assert.ok(
    body.includes("sanitizeMigrationContent(content)"),
    "the runner must strip file-level lock_timeout before executing",
  );
  assert.ok(
    body.includes("executeMigrationAttempt(client,"),
    "each attempt must run through the shared attempt executor",
  );
  assert.ok(
    body.includes("isLockNotAvailable(err)"),
    "only a lock-wait timeout (55P03) may retry the migration",
  );
  assert.ok(
    body.includes("migrationRunsWithoutTransaction(content)"),
    "no-transaction files (CREATE INDEX CONCURRENTLY) must skip BEGIN/COMMIT",
  );
  // The attempt executor lives in the importable client module (bootstrap.ts
  // runs main() on import); its body carries the bound and the split.
  const executor = readFileSync(join(here, "bootstrap-migration-client.ts"), "utf8");
  assert.ok(
    executor.includes("SET LOCAL lock_timeout"),
    "each transactional attempt must run under the bounded lock_timeout",
  );
  assert.ok(
    executor.includes("splitSqlStatements(body)"),
    "no-transaction files must run statement by statement — a multi-statement "
      + "string is one implicit transaction and CONCURRENTLY refuses it",
  );
});

test(
  "a contended lock fires 55P03 under the migration bound, which the runner retries on",
  { skip: !DB },
  async () => {
    const holder = await connectMigrationClient();
    const waiter = await connectMigrationClient();
    try {
      await holder.query("create table if not exists probe_migration_lock_contention (id int)");
      await holder.query("begin");
      await holder.query("lock table probe_migration_lock_contention in access exclusive mode");
      await waiter.query("begin");
      await waiter.query("SET LOCAL lock_timeout = '200ms'");
      const failure = await waiter
        .query("lock table probe_migration_lock_contention in access share mode")
        .then(
          () => null,
          (error: unknown) => error as { code?: string; message: string },
        );
      assert.ok(failure, "the contended lock must fail under the bound");
      assert.equal(failure.code, "55P03");
      assert.equal(isLockNotAvailable(failure), true);
      const lockMessage = describeBootstrapMigrationFailure(
        "generated/0999_probe.sql",
        failure,
        200,
      );
      assert.ok(lockMessage.includes("pg_stat_activity"));
    } finally {
      await waiter.query("rollback").catch(() => {});
      await holder.query("rollback").catch(() => {});
      await holder.query("drop table if exists probe_migration_lock_contention");
      await releaseMigrationClient(waiter);
      await releaseMigrationClient(holder);
    }
  },
);

test(
  "a no-transaction file with CONCURRENTLY builds applies and re-runs through the real attempt executor",
  { skip: !DB },
  async () => {
    // The exact shape 0261 relies on: standard header SETs, a DO block with
    // internal semicolons (the splitter must keep it whole), and two CREATE
    // INDEX CONCURRENTLY statements that refuse any transaction block.
    const file = [
      "-- openbooks: no-transaction",
      "SET statement_timeout = 0;",
      "SET idle_in_transaction_session_timeout = 0;",
      "SET client_encoding = 'UTF8';",
      "SET standard_conforming_strings = on;",
      "SET client_min_messages = warning;",
      "CREATE TABLE IF NOT EXISTS probe_no_txn (id uuid PRIMARY KEY, org_id uuid, item_id uuid);",
      "DO $$",
      "BEGIN",
      "  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'probe_no_txn_check') THEN",
      "    ALTER TABLE probe_no_txn ADD CONSTRAINT probe_no_txn_check CHECK (id IS NOT NULL);",
      "  END IF;",
      "END",
      "$$;",
      "DO $$",
      "DECLARE idx text;",
      "BEGIN",
      "  FOR idx IN SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid",
      "    WHERE NOT i.indisvalid AND c.relname IN ('probe_no_txn_item_a', 'probe_no_txn_item_b') LOOP",
      "    EXECUTE format('DROP INDEX IF EXISTS %I', idx);",
      "  END LOOP;",
      "END",
      "$$;",
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS probe_no_txn_item_a",
      "  ON probe_no_txn USING btree (org_id, item_id) WHERE (item_id IS NOT NULL);",
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS probe_no_txn_item_b",
      "  ON probe_no_txn USING btree (org_id, id);",
    ].join("\n");
    assert.equal(migrationRunsWithoutTransaction(file), true);
    const lock = migrationLockConfig({});
    const filename = "generated/0999_probe_no_txn.sql";
    const digest = "probe-digest";
    const runAttempt = async (): Promise<void> => {
      const client = await connectMigrationClient();
      try {
        await executeMigrationAttempt(client, {
          filename,
          body: sanitizeMigrationContent(file),
          transactional: false,
          lock,
          digest,
          executeBody: executeMigrationBody,
        });
      } finally {
        await releaseMigrationClient(client);
      }
    };
    const setup = await connectMigrationClient();
    try {
      await setup.query(
        `create table if not exists public._applied_migrations (
          filename text primary key, sha256 text not null,
          applied_at timestamptz not null default now()
        )`,
      );
      await setup.query("delete from public._applied_migrations where filename = $1", [filename]);
      await setup.query("drop table if exists probe_no_txn");
      await runAttempt();
      const first = await setup.query<{ name: string; valid: boolean }>(
        `select c.relname as name, i.indisvalid as valid from pg_index i
           join pg_class c on c.oid = i.indexrelid
          where c.relname in ('probe_no_txn_item_a', 'probe_no_txn_item_b')`,
      );
      assert.deepEqual(
        first.rows.map((row) => row.name).sort(),
        ["probe_no_txn_item_a", "probe_no_txn_item_b"],
      );
      assert.ok(first.rows.every((row) => row.valid), "both builds must be valid");

      // Re-running replays the whole body idempotently (the runner's retry
      // replays after a mid-file failure, which leaves earlier statements
      // committed — so drop the ledger row first, exactly as a retry would
      // re-encounter the file).
      await setup.query("delete from public._applied_migrations where filename = $1", [filename]);
      await runAttempt();

      // The INVALID hazard is real: plant one by failing a CONCURRENTLY
      // build under the target name (uuid text never parses as int), show
      // that IF NOT EXISTS alone skips it forever, then show the file's DO
      // block drops it and the rebuild heals it.
      await setup.query("drop index if exists probe_no_txn_item_a");
      await setup.query(
        "insert into probe_no_txn (id, org_id, item_id) values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid())",
      );
      const failed = await setup
        .query(
          "CREATE INDEX CONCURRENTLY probe_no_txn_item_a ON probe_no_txn ((item_id::text::int))",
        )
        .then(
          () => null,
          (error: unknown) => error,
        );
      assert.ok(failed, "the poisoned build must fail");
      const invalid = await setup.query<{ valid: boolean }>(
        `select i.indisvalid as valid from pg_index i join pg_class c on c.oid = i.indexrelid
          where c.relname = 'probe_no_txn_item_a'`,
      );
      assert.equal(invalid.rows.length, 1);
      assert.equal(invalid.rows[0]!.valid, false);
      await setup.query(
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS probe_no_txn_item_a ON probe_no_txn (org_id, item_id)",
      );
      const stillInvalid = await setup.query<{ valid: boolean }>(
        `select i.indisvalid as valid from pg_index i join pg_class c on c.oid = i.indexrelid
          where c.relname = 'probe_no_txn_item_a'`,
      );
      assert.equal(stillInvalid.rows[0]!.valid, false, "IF NOT EXISTS skips the INVALID name");
      await setup.query("delete from public._applied_migrations where filename = $1", [filename]);
      await runAttempt();
      const healed = await setup.query<{ valid: boolean; definition: string }>(
        `select i.indisvalid as valid, pg_get_indexdef(i.indexrelid) as definition
           from pg_index i join pg_class c on c.oid = i.indexrelid
          where c.relname = 'probe_no_txn_item_a'`,
      );
      assert.equal(healed.rows[0]!.valid, true);
      assert.ok(healed.rows[0]!.definition.includes("(org_id, item_id)"));
    } finally {
      await setup.query("drop table if exists probe_no_txn").catch(() => {});
      await setup
        .query("delete from public._applied_migrations where filename = $1", [filename])
        .catch(() => {});
      await releaseMigrationClient(setup);
    }
  },
);

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
