/**
 * 0301 stages the revision-fence guards as NOT VALID + VALIDATE (U12): the
 * two CHECKs and the self-referential foreign key would scan the schedule
 * history under the ALTER TABLE lock. Existing rows start at revision 0
 * with no predecessor and no reason, so NOT VALID enforces new writes under
 * a short lock and VALIDATE scans history under a lock that blocks neither
 * reads nor writes. The end state is identical to the validated build.
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

const PROBE_FILENAME = "generated/0999_g43_0301_probe.sql";
const PROBE_DIGEST = "g43-0301-probe";

const migrationSql = readFileSync(
  new URL("./0301_item_price_schedule_versioning.sql", import.meta.url),
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
  catalogBefore = await snapshotTableCatalog(snapshotQuery, "public.item_price_schedules");
});

afterEach(async () => {
  assert.ok(catalogBefore, "the pre-test catalog snapshot is missing");
  await assertTableCatalogMatches(
    snapshotQuery,
    catalogBefore,
    "0301 replay test must leave item_price_schedules exactly as found",
  );
});

test("replaying the staged file keeps every guard validated", async () => {
  await clearProbeLedger();
  await runStagedFile();
  await clearProbeLedger();
  await runStagedFile();

  const guards = await db.execute<{ name: string; validated: boolean; definition: string }>(sql`
    select conname as name, convalidated as validated, pg_get_constraintdef(oid) as definition
      from pg_constraint
     where conrelid = 'public.item_price_schedules'::regclass
       and conname in (
         'item_price_schedule_revision_nonnegative',
         'item_price_schedule_reason_present',
         'item_price_schedule_supersedes_fk'
       )
     order by conname
  `);
  assert.equal(guards.rows.length, 3, "all three staged guards exist");
  for (const guard of guards.rows) {
    assert.equal(guard.validated, true, `${guard.name} ends validated`);
  }
  const byName = Object.fromEntries(guards.rows.map((row) => [row.name, row.definition]));
  assert.match(byName["item_price_schedule_revision_nonnegative"]!, /CHECK \(\(revision >= 0\)\)/);
  assert.match(byName["item_price_schedule_reason_present"]!, /change_reason/);
  assert.match(
    byName["item_price_schedule_supersedes_fk"]!,
    /FOREIGN KEY \(org_id, supersedes_id\) REFERENCES .*item_price_schedules\(org_id, id\)/,
  );
  await clearProbeLedger().catch(() => {});
});
