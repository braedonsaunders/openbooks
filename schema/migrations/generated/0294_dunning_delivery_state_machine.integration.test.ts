/**
 * 0294 stages the dunning status CHECK replacement as NOT VALID + VALIDATE
 * (U12): the new CHECK is a strict superset of the old one, so no existing
 * row can violate it — NOT VALID enforces new writes under a short lock and
 * VALIDATE scans history under SHARE UPDATE EXCLUSIVE. The end state is
 * identical to the validated build: same name, same expression, validated.
 *
 * Runs without a self-skip: the integration partition always provides a
 * database, so a missing one must fail loudly, never pass silently. Replays
 * the real migration bytes through the real attempt executor under a probe
 * ledger name.
 *
 * The replay is idempotent on a migrated database, so it cannot pollute;
 * the teardown still asserts the table matches its pre-test snapshot, so
 * a future edit that breaks idempotence fails here instead of in the next
 * file of the process order.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test, { afterEach, beforeEach } from "node:test";
import { sql } from "drizzle-orm";
import {
  connectMigrationClient,
  executeMigrationAttempt,
  executeMigrationBody,
  migrationLockConfig,
  releaseMigrationClient,
  sanitizeMigrationContent,
} from "../../../scripts/bootstrap-migration-client.ts";
import {
  assertTableCatalogMatches,
  snapshotTableCatalog,
  type CatalogQuery,
  type TableCatalogSnapshot,
} from "../../../engine/src/testing/migration-catalog.ts";
import { db } from "../../../engine/src/platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
} from "../../../engine/src/testing/fixtures.ts";

const PROBE_FILENAME = "generated/0999_g43_0294_probe.sql";
const PROBE_DIGEST = "g43-0294-probe";

const migrationSql = readFileSync(
  new URL("./0294_dunning_delivery_state_machine.sql", import.meta.url),
  "utf8",
);

async function runStagedFile(): Promise<void> {
  const client = await connectMigrationClient();
  try {
    await executeMigrationAttempt(client, {
      filename: PROBE_FILENAME,
      body: sanitizeMigrationContent(migrationSql),
      transactional: true,
      lock: migrationLockConfig({}),
      digest: PROBE_DIGEST,
      executeBody: (migrationClient, body, step) =>
        executeMigrationBody(migrationClient, body, step),
    });
  } finally {
    await releaseMigrationClient(client);
  }
}

async function clearProbeLedger(): Promise<void> {
  const client = await connectMigrationClient();
  try {
    await client.query("delete from public._applied_migrations where filename = $1", [PROBE_FILENAME]);
  } finally {
    await releaseMigrationClient(client);
  }
}

async function catalogQuery(text: string): Promise<Array<Record<string, unknown>>> {
  const client = await connectMigrationClient();
  try {
    return (await client.query(text)).rows as Array<Record<string, unknown>>;
  } finally {
    await releaseMigrationClient(client);
  }
}

const snapshotQuery: CatalogQuery = (text) => catalogQuery(text);

let catalogBefore: TableCatalogSnapshot | null = null;

beforeEach(async () => {
  catalogBefore = await snapshotTableCatalog(snapshotQuery, "public.dunning_log");
});

afterEach(async () => {
  assert.ok(catalogBefore, "the pre-test catalog snapshot is missing");
  await assertTableCatalogMatches(
    snapshotQuery,
    catalogBefore,
    "0294 replay test must leave dunning_log exactly as found",
  );
});

test("the staged file pins the build shape and ends validated", async () => {
  // The fix is the staging itself: NOT VALID first, a guarded VALIDATE
  // after, and no bare validated ADD that would scan under the ALTER lock.
  assert.match(migrationSql, /ADD CONSTRAINT dunning_log_status/);
  assert.match(migrationSql, /NOT VALID/);
  assert.match(migrationSql, /VALIDATE CONSTRAINT dunning_log_status/);
  assert.doesNotMatch(migrationSql, /lock_timeout/i);
});

test("replaying the staged file keeps the guard validated and enforcing", async () => {
  const org = await createScratchOrg();
  try {
    await clearProbeLedger();
    await runStagedFile();
    await clearProbeLedger();
    await runStagedFile();

    const guard = await db.execute<{ validated: boolean; definition: string }>(sql`
      select convalidated as validated, pg_get_constraintdef(oid) as definition
        from pg_constraint
       where conrelid = 'public.dunning_log'::regclass
         and conname = 'dunning_log_status'
    `);
    assert.equal(guard.rows.length, 1);
    assert.equal(guard.rows[0]!.validated, true, "the staged guard ends validated");
    assert.match(guard.rows[0]!.definition, /'staged'::text/);
    assert.match(guard.rows[0]!.definition, /'suppressed'::text/);

    // The lifecycle still refuses an unknown status under the same name.
    await assert.rejects(
      db.execute(sql`
        insert into dunning_log
          (id, org_id, document_id, policy_id, stage_id, status)
        values (${randomUUID()}, ${org.orgId}, ${randomUUID()}, ${randomUUID()}, ${randomUUID()}, 'bogus')
      `),
      (error: unknown) => {
        const cause = (error as { cause?: unknown }).cause as Error | undefined;
        assert.match(String(cause?.message ?? error), /dunning_log_status/i);
        return true;
      },
      "an unknown status still violates the staged guard",
    );
  } finally {
    await clearProbeLedger().catch(() => {});
    await dropScratchOrg(org.orgId);
  }
});
