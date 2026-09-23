/**
 * A killed out-of-transaction migration must resume to a clean catalog.
 *
 * A no-transaction file (CREATE INDEX CONCURRENTLY and friends) commits
 * statement by statement with the ledger row written only after the last
 * step. Killing the runner mid-file therefore leaves committed objects and
 * NO ledger row; the next run replays the whole file from its first step.
 * This proves that shape directly against a real database: kill after step
 * 2 of 6, show the partial catalog with no ledger row, resume through the
 * real attempt executor, and show a valid index, an enforced constraint,
 * and exactly one ledger row.
 *
 * The INVALID-index hazard (a failed CONCURRENTLY build leaves the name
 * present but unusable, and IF NOT EXISTS skips it forever) is covered at
 * the runner level in bootstrap-migration-pool.integration.test.ts and at
 * the file level by each staged migration's own drop-up-front DO block;
 * this file proves the kill/resume half of crash safety.
 *
 * Runs without a self-skip: the integration partition always provides a
 * database, so a missing one must fail loudly, never pass silently.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  connectMigrationClient,
  executeMigrationAttempt,
  executeMigrationBody,
  migrationLockConfig,
  releaseMigrationClient,
  sanitizeMigrationContent,
  splitSqlStatements,
} from "./bootstrap-migration-client.ts";

const FILENAME = "generated/0999_g43_resume_probe.sql";
const DIGEST = "g43-resume-probe";

const BODY = [
  "-- openbooks: no-transaction",
  "SET statement_timeout = 0;",
  "SET idle_in_transaction_session_timeout = 0;",
  "SET client_encoding = 'UTF8';",
  "SET standard_conforming_strings = on;",
  "SET client_min_messages = warning;",
  "CREATE TABLE IF NOT EXISTS probe_g43_resume (org_id uuid, item_id uuid, payload text);",
  "INSERT INTO probe_g43_resume (org_id, item_id, payload)",
  "SELECT '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'seed'",
  "WHERE NOT EXISTS (SELECT 1 FROM probe_g43_resume);",
  "DO $$",
  "DECLARE idx text;",
  "BEGIN",
  "  FOR idx IN SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid",
  "    WHERE NOT i.indisvalid AND c.relname IN ('probe_g43_resume_item') LOOP",
  "    EXECUTE format('DROP INDEX IF EXISTS %I', idx);",
  "  END LOOP;",
  "END",
  "$$;",
  "CREATE INDEX CONCURRENTLY IF NOT EXISTS probe_g43_resume_item",
  "  ON probe_g43_resume USING btree (org_id, item_id);",
  "DO $$",
  "BEGIN",
  "  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'probe_g43_resume_payload_present') THEN",
  "    ALTER TABLE probe_g43_resume ADD CONSTRAINT probe_g43_resume_payload_present CHECK (payload IS NOT NULL);",
  "  END IF;",
  "END",
  "$$;",
].join("\n");

async function ledgerRows(client: { query: (sql: string, values?: unknown[]) => Promise<{ rows: { sha256: string }[] }> }): Promise<{ sha256: string }[]> {
  const found = await client.query("select sha256 from public._applied_migrations where filename = $1", [FILENAME]);
  return found.rows;
}

test("a kill mid-file leaves objects but no ledger row; the resume heals to a valid catalog", async () => {
  const lock = migrationLockConfig({});
  const body = sanitizeMigrationContent(BODY);
  const setup = await connectMigrationClient();
  try {
    await setup.query("delete from public._applied_migrations where filename = $1", [FILENAME]);
    await setup.query("drop table if exists probe_g43_resume");

    // The kill: two steps commit, then the process dies before the ledger write.
    const killer = await connectMigrationClient();
    try {
      await assert.rejects(
        executeMigrationAttempt(killer, {
          filename: FILENAME,
          body,
          transactional: false,
          lock,
          digest: DIGEST,
          executeBody: async (client, fileBody, step) => {
            const statements = splitSqlStatements(fileBody);
            const seededThrough =
              statements.findIndex((statement) => /insert\s+into\s+probe_g43_resume/i.test(statement)) + 1;
            assert.ok(seededThrough > 1 && seededThrough < statements.length);
            for (const statement of statements.slice(0, seededThrough)) {
              await client.query(statement);
            }
            void step;
            throw new Error("simulated kill after the seed step");
          },
        }),
        /simulated kill/,
      );
    } finally {
      await releaseMigrationClient(killer);
    }
    assert.deepEqual(await ledgerRows(setup), [], "a killed attempt leaves no ledger row");
    const partial = await setup.query<{ tableExists: boolean; indexExists: boolean }>(
      `select exists (select 1 from pg_tables where tablename = 'probe_g43_resume') as "tableExists",
              exists (select 1 from pg_class where relname = 'probe_g43_resume_item') as "indexExists"`,
    );
    assert.equal(partial.rows[0]!.tableExists, true, "committed steps survive the kill");
    assert.equal(partial.rows[0]!.indexExists, false, "later steps never ran");

    // The resume: the whole file replays idempotently through the real executor.
    const resumer = await connectMigrationClient();
    try {
      await executeMigrationAttempt(resumer, {
        filename: FILENAME,
        body,
        transactional: false,
        lock,
        digest: DIGEST,
        executeBody: (client, fileBody, step) => executeMigrationBody(client, fileBody, step),
      });
    } finally {
      await releaseMigrationClient(resumer);
    }
    const recorded = await ledgerRows(setup);
    assert.equal(recorded.length, 1, "the resume records the ledger row exactly once");
    assert.equal(recorded[0]!.sha256, DIGEST);
    const healed = await setup.query<{ valid: boolean; constrained: boolean; seeded: boolean }>(
      `select i.indisvalid as valid,
              exists (select 1 from pg_constraint where conname = 'probe_g43_resume_payload_present') as constrained,
              exists (select 1 from probe_g43_resume) as seeded
         from pg_index i join pg_class c on c.oid = i.indexrelid
        where c.relname = 'probe_g43_resume_item'`,
    );
    assert.equal(healed.rows.length, 1, "the concurrent index exists after resume");
    assert.equal(healed.rows[0]!.valid, true, "the resumed build is valid, not INVALID");
    assert.equal(healed.rows[0]!.constrained, true, "later steps ran on resume");
    assert.equal(healed.rows[0]!.seeded, true, "the idempotent seed ran once");
  } finally {
    await setup.query("drop table if exists probe_g43_resume").catch(() => {});
    await setup.query("delete from public._applied_migrations where filename = $1", [FILENAME]).catch(() => {});
    await releaseMigrationClient(setup);
  }
});
