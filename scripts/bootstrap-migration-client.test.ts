/**
 * The migration runner's lock discipline lives in pure helpers in
 * bootstrap-migration-client.ts (bootstrap.ts runs main() on import, so it
 * cannot be imported here): bounded lock_timeout config, the 55P03 retry
 * signal, the no-transaction directive, and the file-level lock_timeout
 * strip. These tests pin the refusal-relevant behavior: only a lock-wait
 * timeout retries, and no published `SET lock_timeout = 0` survives the
 * strip — including the exact header spellings the migrations use.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import {
  DEFAULT_MIGRATION_LOCK_MAX_ATTEMPTS,
  DEFAULT_MIGRATION_LOCK_RETRY_BASE_MS,
  DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
  describeBootstrapMigrationFailure,
  executeMigrationAttempt,
  executeMigrationBody,
  isLockNotAvailable,
  migrationLockConfig,
  migrationRetryDelayMs,
  migrationRunsWithoutTransaction,
  sanitizeMigrationContent,
  splitSqlStatements,
} from "./bootstrap-migration-client.ts";

const here = dirname(fileURLToPath(import.meta.url));
const generatedDir = join(here, "..", "schema", "migrations", "generated");

test("lock config defaults to a bounded few-second wait with limited retries", () => {
  assert.deepEqual(migrationLockConfig({}), {
    lockTimeoutMs: DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
    maxAttempts: DEFAULT_MIGRATION_LOCK_MAX_ATTEMPTS,
    retryBaseMs: DEFAULT_MIGRATION_LOCK_RETRY_BASE_MS,
  });
  assert.equal(DEFAULT_MIGRATION_LOCK_TIMEOUT_MS, 5_000);
});

test("lock config honors explicit env and rejects garbage with the default", () => {
  assert.deepEqual(
    migrationLockConfig({
      OPENBOOKS_MIGRATION_LOCK_TIMEOUT_MS: "10000",
      OPENBOOKS_MIGRATION_LOCK_MAX_ATTEMPTS: "3",
      OPENBOOKS_MIGRATION_LOCK_RETRY_BASE_MS: "250",
    }),
    { lockTimeoutMs: 10_000, maxAttempts: 3, retryBaseMs: 250 },
  );
  const garbage = migrationLockConfig({
    OPENBOOKS_MIGRATION_LOCK_TIMEOUT_MS: "forever",
    OPENBOOKS_MIGRATION_LOCK_MAX_ATTEMPTS: "0",
    OPENBOOKS_MIGRATION_LOCK_RETRY_BASE_MS: "-5",
  });
  assert.deepEqual(garbage, migrationLockConfig({}));
  // Zero or negative attempts would retry forever or never try at all.
  assert.ok(garbage.maxAttempts >= 1);
});

test("retry backoff doubles from the base and caps at thirty seconds", () => {
  const config = { lockTimeoutMs: 5_000, maxAttempts: 25, retryBaseMs: 1_000 };
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((attempt) => migrationRetryDelayMs(config, attempt)),
    [1_000, 2_000, 4_000, 8_000, 16_000],
  );
  assert.equal(migrationRetryDelayMs(config, 20), 30_000);
});

test("only SQLSTATE 55P03 signals a lock-wait retry", () => {
  const lockTimeout = new Error(
    'canceling statement due to lock timeout: "canceling statement due to lock timeout"',
  ) as Error & { code: string };
  lockTimeout.code = "55P03";
  assert.equal(isLockNotAvailable(lockTimeout), true);
  const deadlock = new Error("deadlock detected") as Error & { code: string };
  deadlock.code = "40P01";
  assert.equal(isLockNotAvailable(deadlock), false);
  assert.equal(isLockNotAvailable(new Error("duplicate key value")), false);
  assert.equal(isLockNotAvailable(null), false);
});

test("a lock_timeout failure names the blocker hunt and the scheduling remedy", () => {
  const err = new Error("canceling statement due to lock timeout") as Error & {
    code: string;
  };
  err.code = "55P03";
  const message = describeBootstrapMigrationFailure("generated/0251_payment_link_token_at_rest.sql", err, 5_100);
  assert.ok(message.includes("generated/0251_payment_link_token_at_rest.sql"));
  assert.ok(message.includes("lock_timeout") || message.includes("lock"));
  assert.ok(message.includes("pg_stat_activity"));
  assert.ok(message.includes("OPENBOOKS_MIGRATION_LOCK_TIMEOUT_MS"));
  assert.ok(message.includes("OPENBOOKS_MIGRATION_LOCK_MAX_ATTEMPTS"));
});

test("the no-transaction directive is an exact comment line, not a substring", () => {
  assert.equal(migrationRunsWithoutTransaction("-- openbooks: no-transaction\nselect 1;"), true);
  assert.equal(migrationRunsWithoutTransaction("  --   OPENBOOKS:   NO-TRANSACTION  \nselect 1;"), true);
  assert.equal(migrationRunsWithoutTransaction("-- openbooks: no-transaction-ish\nselect 1;"), false);
  assert.equal(
    migrationRunsWithoutTransaction("select '-- openbooks: no-transaction';"),
    false,
  );
  assert.equal(migrationRunsWithoutTransaction("SET lock_timeout = 0;\nselect 1;"), false);
});

test("the sanitizer strips every file-level lock_timeout spelling", () => {
  const body = [
    "SET lock_timeout = 0;",
    "SET LOCAL lock_timeout TO '0s';",
    "SET LOCAL lock_timeout = '5s';",
    "set session lock_timeout=0",
    "RESET lock_timeout;",
    "SET lock_timeout = '5s';",
    "select 1;",
  ].join("\n");
  const clean = sanitizeMigrationContent(body);
  assert.doesNotMatch(clean, /lock_timeout/i);
  assert.match(clean, /select 1;/);
});

test("the sanitizer leaves lock_timeout prose and function bodies alone", () => {
  const body = [
    "-- SET lock_timeout = 0 would hang here, so the runner bounds it.",
    "/* SET lock_timeout = 0; */",
    "CREATE OR REPLACE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$",
    "BEGIN",
    "  RAISE NOTICE 'SET lock_timeout = 0 is stripped only at file level';",
    "END",
    "$$;",
    "SELECT 'SET lock_timeout = 0';",
    'SELECT "lock_timeout";',
  ].join("\n");
  assert.equal(sanitizeMigrationContent(body), body);
});

test("no published migration keeps a file-level lock_timeout after the strip", () => {
  const files = readdirSync(generatedDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  assert.ok(files.length > 200, "expected the full published migration set");
  const survivors: string[] = [];
  for (const file of files) {
    const content = readFileSync(join(generatedDir, file), "utf8");
    const clean = sanitizeMigrationContent(content);
    const withoutComments = clean.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    if (/(^|\s)(set\s+(?:(?:session|local)\s+)?lock_timeout|reset\s+lock_timeout)\b/i.test(withoutComments)) {
      survivors.push(file);
    }
  }
  assert.deepEqual(survivors, []);
});

test("the splitter keeps dollar-quoted bodies whole and drops empties", () => {
  const statements = splitSqlStatements(
    [
      "SET statement_timeout = 0;",
      "",
      "-- a comment; with a semicolon",
      "DO $$",
      "BEGIN",
      "  RAISE NOTICE 'a;b';",
      "END;",
      "$$;",
      "CREATE OR REPLACE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $body$",
      "BEGIN",
      "  PERFORM 1;",
      "END;",
      "$body$;",
      "SELECT 'semi;colon', \"weird;ident\"; /* trailing; comment */",
      "",
    ].join("\n"),
  );
  assert.equal(statements.length, 4);
  assert.match(statements[0]!, /SET statement_timeout/);
  assert.match(statements[1]!, /RAISE NOTICE 'a;b'/);
  assert.match(statements[2]!, /\$body\$/);
  assert.match(statements[3]!, /SELECT 'semi;colon', "weird;ident"/);
});

test("the splitter does not mistake a cast or a placeholder for a dollar quote", () => {
  const statements = splitSqlStatements(
    "SELECT 1::$regclass; SELECT $1;",
  );
  assert.equal(statements.length, 2);
});

test("the sanitizer keeps nested comments, escaped quotes and tagged dollar bodies intact", () => {
  const preserved = [
    "/* outer /* nested SET lock_timeout = 0; */ still comment */\nselect 1;",
    "SELECT 'it''s SET lock_timeout = 0;';",
    "DO $body$\nBEGIN\n  PERFORM 'SET lock_timeout = 0;';\nEND;\n$body$;",
    "select $$SET lock_timeout = 0;$$;",
    "SELECT 1::$regclass;",
    'SELECT "SET lock_timeout = 0";',
  ];
  for (const body of preserved) {
    assert.equal(sanitizeMigrationContent(body), body, `must preserve: ${body.slice(0, 60)}`);
  }
});

test("the sanitizer strips TO/=/RESET forms with or without a semicolon, any case", () => {
  const cases: Array<[string, string]> = [
    ["SET lock_timeout TO 0", ""],
    ["RESET lock_timeout", ""],
    ["SeT LoCaL lOcK_TiMeOuT To 0;", ""],
    ["SET\n  lock_timeout\n  =\n  0;", ""],
    ["select 1; SET lock_timeout = 0; select 2;", "select 1;  select 2;"],
    ["$tag$SET lock_timeout = 0;$tag$ SET lock_timeout = 0;", "$tag$SET lock_timeout = 0;$tag$ "],
  ];
  for (const [input, expected] of cases) {
    assert.equal(sanitizeMigrationContent(input), expected, `must strip: ${input.slice(0, 60)}`);
  }
});

test("sanitize and split stay linear on the real baseline and a 5 MB synthetic body (perf regression)", () => {
  const baseline = readFileSync(join(generatedDir, "0001_baseline.sql"), "utf8");
  assert.ok(baseline.length > 1_000_000, "expected the real multi-megabyte baseline");
  let started = performance.now();
  const clean = sanitizeMigrationContent(baseline);
  const sanitizeMs = performance.now() - started;
  assert.ok(sanitizeMs < 2_000, `sanitize took ${sanitizeMs.toFixed(0)}ms on ${(baseline.length / 1e6).toFixed(1)} MB`);
  started = performance.now();
  const statements = splitSqlStatements(baseline);
  const splitMs = performance.now() - started;
  assert.ok(splitMs < 2_000, `split took ${splitMs.toFixed(0)}ms on ${(baseline.length / 1e6).toFixed(1)} MB`);
  assert.ok(statements.length > 0);
  assert.doesNotMatch(clean, /^\s*set\s+(?:(?:session|local)\s+)?lock_timeout/m);

  // Synthetic 5 MB body mixing prose, dollar bodies, quoted escapes and real
  // SET statements, so the bound covers every scanner state, not just DDL.
  const chunk = [
    "select 1; -- SET lock_timeout = 0 is prose, not a GUC assignment",
    "DO $$ BEGIN RAISE NOTICE 'SET lock_timeout = 0;'; END; $$;",
    "SELECT 'it''s quoted';",
    "SET lock_timeout = 0;",
    "/* block /* nested SET lock_timeout = 0; */ comment */",
  ].join("\n") + "\n";
  const synthetic = chunk.repeat(Math.ceil((5 * 1024 * 1024) / chunk.length));
  assert.ok(synthetic.length >= 5 * 1024 * 1024, "expected a >= 5 MB synthetic body");
  started = performance.now();
  const cleanSynthetic = sanitizeMigrationContent(synthetic);
  const syntheticSanitizeMs = performance.now() - started;
  assert.ok(
    syntheticSanitizeMs < 2_000,
    `sanitize took ${syntheticSanitizeMs.toFixed(0)}ms on ${(synthetic.length / 1e6).toFixed(1)} MB synthetic`,
  );
  started = performance.now();
  splitSqlStatements(synthetic);
  const syntheticSplitMs = performance.now() - started;
  assert.ok(
    syntheticSplitMs < 2_000,
    `split took ${syntheticSplitMs.toFixed(0)}ms on ${(synthetic.length / 1e6).toFixed(1)} MB synthetic`,
  );
  assert.ok(cleanSynthetic.includes("-- SET lock_timeout = 0 is prose"));
  assert.ok(cleanSynthetic.includes("RAISE NOTICE 'SET lock_timeout = 0;'"));
  assert.doesNotMatch(cleanSynthetic, /^SET lock_timeout = 0;$/m);
});

/** A PoolClient double that records every statement and fails on demand. The
 * runner only calls query(), so the double implements nothing else. */
function recordingClient(
  onQuery?: (sql: string, calls: string[]) => Promise<unknown>,
): { client: pg.PoolClient; calls: string[] } {
  const calls: string[] = [];
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      if (onQuery) await onQuery(sql, calls);
      return { rows: [], rowCount: 0 };
    },
  } as unknown as pg.PoolClient;
  return { client, calls };
}

const RESUME_BODY = [
  "CREATE TABLE IF NOT EXISTS probe_resume (id integer PRIMARY KEY);",
  "INSERT INTO probe_resume (id) VALUES (1);",
  "CREATE INDEX IF NOT EXISTS probe_resume_id ON probe_resume (id);",
].join("\n");

test("a no-transaction step failure names the file, the step, and the resume remedy", async () => {
  const { client } = recordingClient(async (_sql, calls) => {
    if (calls.length === 3) throw new Error("relation \"probe_resume\" does not exist");
  });
  await assert.rejects(
    executeMigrationBody(client, RESUME_BODY, { transactional: false, filename: "generated/0999_probe.sql" }),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.ok(message.includes("generated/0999_probe.sql"), "names the file");
      assert.ok(message.includes("step 3/3"), "names the step");
      assert.ok(message.includes("committed"), "says earlier steps are committed");
      assert.ok(message.includes("re-run"), "names the resume remedy");
      assert.ok(message.includes("does not exist"), "keeps the driver cause text");
      return true;
    },
  );
});

test("a lock-wait failure passes through unwrapped so the attempt still retries", async () => {
  const lockError = new Error("canceling statement due to lock timeout") as Error & {
    code: string;
  };
  lockError.code = "55P03";
  const { client } = recordingClient(async () => {
    throw lockError;
  });
  let caught: unknown = null;
  try {
    await executeMigrationBody(client, RESUME_BODY, { transactional: false, filename: "generated/0999_probe.sql" });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught, lockError, "the raw 55P03 must reach the retry loop untouched");
  assert.equal(isLockNotAvailable(caught), true);
});

test("a killed no-transaction attempt writes no ledger row; the resume completes with exactly one", async () => {
  const lock = migrationLockConfig({});
  const filename = "generated/0999_probe.sql";
  const digest = "probe-digest";
  const ledgerWrites = (calls: string[]): string[] =>
    calls.filter((sql) => /_applied_migrations/.test(sql) && /insert/i.test(sql));

  // First attempt: the process dies after the first statement — the kill
  // happens inside the body, before the ledger write.
  const killed = recordingClient();
  const killBody = async (client: pg.PoolClient, body: string): Promise<void> => {
    const [first] = body.split(";");
    await client.query(`${first};`);
    throw new Error("simulated kill after step 1");
  };
  await assert.rejects(
    executeMigrationAttempt(killed.client, {
      filename,
      body: RESUME_BODY,
      transactional: false,
      lock,
      digest,
      executeBody: killBody,
    }),
    /simulated kill/,
  );
  assert.deepEqual(ledgerWrites(killed.calls), [], "a killed attempt must leave no ledger row");

  // Resume: the full body replays from its first step and records once.
  const resumed = recordingClient();
  await executeMigrationAttempt(resumed.client, {
    filename,
    body: RESUME_BODY,
    transactional: false,
    lock,
    digest,
    executeBody: (client, body, step) => executeMigrationBody(client, body, step),
  });
  assert.equal(ledgerWrites(resumed.calls).length, 1, "the resume records the ledger row once");
  const ledgerIndex = resumed.calls.findIndex((sql) => /_applied_migrations/.test(sql));
  for (const stepStatement of splitSqlStatements(RESUME_BODY)) {
    assert.ok(
      resumed.calls.indexOf(stepStatement) !== -1
        && resumed.calls.indexOf(stepStatement) < ledgerIndex,
      `step runs before the ledger write: ${stepStatement.slice(0, 40)}`,
    );
  }
});

test("the real 0251 header is neutralized exactly where the runner would run it", () => {
  const content = readFileSync(
    join(generatedDir, "0251_payment_link_token_at_rest.sql"),
    "utf8",
  );
  assert.match(content, /SET lock_timeout = 0;/);
  const clean = sanitizeMigrationContent(content);
  assert.doesNotMatch(clean, /SET lock_timeout/i);
  assert.match(clean, /CREATE UNIQUE INDEX IF NOT EXISTS payment_links_token_hash/);
});
