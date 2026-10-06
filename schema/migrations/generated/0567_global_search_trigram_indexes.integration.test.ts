/**
 * 0567 builds the global-search trigram indexes CONCURRENTLY under
 * `-- openbooks: no-transaction`, after dropping any INVALID copy a failed
 * earlier attempt left behind. Replays the real migration bytes through the
 * real attempt executor under a probe ledger name.
 *
 * The cleanup must touch only this file's own indexes: the public schema, on
 * their intended tables. An index with the same name in another schema is
 * someone else's — and if the cleanup matched it by name alone and then
 * dropped by unqualified name, search_path would resolve the drop to the
 * VALID public index instead.
 *
 * Runs without a self-skip: the integration partition always provides a
 * database, so a missing one must fail loudly, never pass silently.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  connectMigrationClient,
  executeMigrationAttempt,
  executeMigrationBody,
  migrationLockConfig,
  releaseMigrationClient,
  sanitizeMigrationContent,
} from "../../../scripts/bootstrap-migration-client.ts";

const PROBE_FILENAME = "generated/0999_0567_search_index_probe.sql";
const PROBE_DIGEST = "0567-search-index-probe";
const SHADOW_SCHEMA = "search_index_shadow";

const INDEXES: Array<[index: string, table: string]> = [
  ["document_lines_description_trgm", "document_lines"],
  ["contacts_name_trgm", "contacts"],
  ["contacts_email_trgm", "contacts"],
  ["custom_records_search_text_trgm", "custom_records"],
  ["custom_records_record_number_trgm", "custom_records"],
];

const migrationSql = readFileSync(
  new URL("./0567_global_search_trigram_indexes.sql", import.meta.url),
  "utf8",
);

async function query<T extends Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  const client = await connectMigrationClient();
  try {
    return (await client.query(text, values)).rows as T[];
  } finally {
    await releaseMigrationClient(client);
  }
}

async function runFile(): Promise<void> {
  await query("delete from public._applied_migrations where filename = $1", [PROBE_FILENAME]);
  const client = await connectMigrationClient();
  try {
    await executeMigrationAttempt(client, {
      filename: PROBE_FILENAME,
      body: sanitizeMigrationContent(migrationSql),
      transactional: false,
      lock: migrationLockConfig({}),
      digest: PROBE_DIGEST,
      executeBody: (migrationClient, body, step) => executeMigrationBody(migrationClient, body, step),
    });
  } finally {
    await releaseMigrationClient(client);
  }
  await query("delete from public._applied_migrations where filename = $1", [PROBE_FILENAME]);
}

async function publicIndex(name: string): Promise<{ oid: string; valid: boolean; table: string } | undefined> {
  const rows = await query<{ oid: string; valid: boolean; table: string }>(
    `select c.oid::text as oid, i.indisvalid as valid, t.relname as table
       from pg_index i
       join pg_class c on c.oid = i.indexrelid
       join pg_class t on t.oid = i.indrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = $1`,
    [name],
  );
  return rows[0];
}

test("replaying the file leaves every search index valid on its intended table", async () => {
  await runFile();
  await runFile();
  for (const [index, table] of INDEXES) {
    const found = await publicIndex(index);
    assert.ok(found, `public.${index} exists`);
    assert.equal(found.valid, true, `public.${index} ends valid`);
    assert.equal(found.table, table, `public.${index} indexes ${table}`);
  }
});

test("an invalid same-named index in another schema never costs the valid public index", async () => {
  await runFile();
  const before = await publicIndex("contacts_name_trgm");
  assert.ok(before?.valid, "the public index starts valid");
  try {
    // A failed concurrent build is how an INVALID index arises in practice:
    // the duplicate rows make the unique build fail after the catalog entry
    // exists, leaving it behind INVALID.
    await query(`create schema if not exists ${SHADOW_SCHEMA}`);
    await query(`create table ${SHADOW_SCHEMA}.contacts (name text)`);
    await query(`insert into ${SHADOW_SCHEMA}.contacts (name) values ('duplicate'), ('duplicate')`);
    await assert.rejects(query(`create unique index concurrently contacts_name_trgm on ${SHADOW_SCHEMA}.contacts (name)`));
    const shadow = await query<{ valid: boolean }>(
      `select i.indisvalid as valid from pg_index i
         where i.indexrelid = '${SHADOW_SCHEMA}.contacts_name_trgm'::regclass`,
    );
    assert.equal(shadow[0]?.valid, false, "the other schema now holds an invalid contacts_name_trgm");

    await runFile();

    const after = await publicIndex("contacts_name_trgm");
    assert.ok(after, "the valid public index must survive the cleanup");
    assert.equal(after.valid, true);
    assert.equal(
      after.oid,
      before.oid,
      "the public index must be the same index, not dropped and rebuilt because another schema's invalid copy shared its name",
    );
    const stillShadowed = await query(`select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = '${SHADOW_SCHEMA}' and c.relname = 'contacts_name_trgm'`);
    assert.equal(stillShadowed.length, 1, "another schema's index is not this migration's to drop");
  } finally {
    await query(`drop schema if exists ${SHADOW_SCHEMA} cascade`);
  }
});
