/**
 * 0257 backfills subsidiary ownership onto inventory_provisional_costs and
 * pins it with two lookup indexes plus two composite foreign keys.
 * inventory_provisional_costs is a hot transactional table, so the staged
 * build carries `-- openbooks: no-transaction`: both indexes build
 * CONCURRENTLY and both foreign keys arrive NOT VALID with separate guarded
 * VALIDATE steps.
 *
 * The guards must exist, end valid/validated, and the file must keep its
 * staged markers: a future edit that reintroduces a validated ADD or a
 * transactional index build fails here instead of blocking writers on a
 * populated install. Replays the real migration bytes through the real
 * attempt executor under a probe ledger name, twice: the body is idempotent,
 * so the second run is exactly what a runner retry does.
 *
 * Runs without a self-skip: the integration partition always provides a
 * database, so a missing one must fail loudly, never pass silently. The
 * teardown asserts the table still matches its pre-test snapshot.
 */
import assert from "node:assert/strict";
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

const PROBE_FILENAME = "generated/0999_g54_0257_probe.sql";
const PROBE_DIGEST = "g54-0257-probe";

const migrationSql = readFileSync(
  new URL("./0257_provisional_cost_subsidiary.sql", import.meta.url),
  "utf8",
);

async function runStagedFile(): Promise<void> {
  const client = await connectMigrationClient();
  try {
    await executeMigrationAttempt(client, {
      filename: PROBE_FILENAME,
      body: sanitizeMigrationContent(migrationSql),
      transactional: false,
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
  catalogBefore = await snapshotTableCatalog(
    snapshotQuery,
    "public.inventory_provisional_costs",
  );
});

afterEach(async () => {
  assert.ok(catalogBefore, "the pre-test catalog snapshot is missing");
  await assertTableCatalogMatches(
    snapshotQuery,
    catalogBefore,
    "0257 replay test must leave inventory_provisional_costs exactly as found",
  );
});

test("the staged file pins the no-transaction build shape", async () => {
  // The fix is the staging itself: a no-transaction file, CONCURRENTLY
  // index builds, NOT VALID foreign keys with guarded VALIDATEs, and the
  // INVALID-index drop that keeps a failed concurrent build retry-safe.
  assert.match(migrationSql, /--\s*openbooks:\s*no-transaction/);
  assert.match(migrationSql, /CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS inv_provisional_org_sub_id/);
  assert.match(migrationSql, /CREATE INDEX CONCURRENTLY IF NOT EXISTS inventory_provisional_subsidiary_fifo/);
  assert.match(migrationSql, /REFERENCES public\.subsidiaries \(org_id, id\) NOT VALID/);
  assert.match(migrationSql, /REFERENCES public\.inventory_movements \(org_id, subsidiary_id, id\) NOT VALID/);
  assert.match(migrationSql, /VALIDATE CONSTRAINT inv_provisional_org_subsidiary_fk/);
  assert.match(migrationSql, /VALIDATE CONSTRAINT inv_provisional_issue_movement_entity_fk/);
});

test("replaying the staged file keeps indexes valid and guards validated", async () => {
  await clearProbeLedger();
  await runStagedFile();
  await clearProbeLedger();
  await runStagedFile();

  const indexes = await db.execute<{ name: string; valid: boolean }>(sql`
    select c.relname as name, i.indisvalid as valid
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
     where i.indrelid = 'public.inventory_provisional_costs'::regclass
       and c.relname in ('inv_provisional_org_sub_id', 'inventory_provisional_subsidiary_fifo')
  `);
  assert.equal(indexes.rows.length, 2);
  for (const row of indexes.rows) {
    assert.equal(row.valid, true, `index ${row.name} ends valid`);
  }

  const guards = await db.execute<{ name: string; validated: boolean }>(sql`
    select conname as name, convalidated as validated
      from pg_constraint
     where conrelid = 'public.inventory_provisional_costs'::regclass
       and conname in ('inv_provisional_org_subsidiary_fk', 'inv_provisional_issue_movement_entity_fk')
  `);
  assert.equal(guards.rows.length, 2);
  for (const row of guards.rows) {
    assert.equal(row.validated, true, `guard ${row.name} ends validated`);
  }

  await clearProbeLedger().catch(() => {});
});
