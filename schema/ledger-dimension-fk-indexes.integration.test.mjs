/// <reference types="node" />

/**
 * Behavioral coverage for 0261_ledger_dimension_fk_indexes — the dimension-FK
 * backing indexes on the three big ledger tables (journal_lines,
 * document_lines, time_entries).
 *
 * Deleting a department (or any sandbox refresh / org purge touching a
 * referenced row) fires one FK check per referencing row; with no index each
 * check scans all of the org's lines. 0261 builds the missing composite
 * (org_id, fk) indexes CONCURRENTLY (partial where the pointer is sparse),
 * with an INVALID-index cleanup that makes a retry safe: a failed
 * CONCURRENTLY build leaves an INVALID index under the target name, and a
 * bare IF NOT EXISTS would skip that name forever.
 *
 * What these tests assert, through the live database rather than the
 * migration's text:
 * - no INVALID index residue exists on the three tables (the ongoing
 *   property the cleanup exists to protect — any future failed CONCURRENTLY
 *   build on these tables turns this red);
 * - the detector fires on the real hazard, by planting a genuinely failed
 *   CONCURRENTLY build and showing the same query names it.
 *
 * Deliberately not asserted here: the 28 exact index names and predicates
 * (a hand list of one migration's spelling), the no-transaction directive
 * and lock_timeout absence (owned by the check:migration-headers gate and
 * the no-published-survivors sanitizer test, which cover 0261 with the whole
 * corpus), the INVALID-cleanup statement list (the retry-heal pattern is
 * proven through the real attempt executor by the bootstrap pool's
 * CONCURRENTLY test), and the Drizzle mirror parity (mirror index lists
 * have no runtime effect and no conformance backstop; the database property
 * is what matters and is covered above).
 *
 * Runs without a self-skip: the integration partition always provides a
 * database, so a missing one must fail loudly, never pass silently.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../engine/src/platform/db.ts";

const LEDGER_TABLES = ["journal_lines", "document_lines", "time_entries"];

/** INVALID indexes on the given tables — residue of a failed CONCURRENTLY build. */
async function invalidIndexes(database, tables) {
  const rows = await database.execute(sql`
    select c.relname as name
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      join pg_class t on t.oid = i.indrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname in (${sql.join(
         tables.map((table) => sql`${table}`),
         sql`, `,
       )})
       and not i.indisvalid
     order by 1`);
  return rows.rows.map((row) => row.name);
}

test("the ledger tables carry no INVALID index residue", async () => {
  const residue = await invalidIndexes(db, LEDGER_TABLES);
  assert.deepEqual(
    residue,
    [],
    `a failed CONCURRENTLY build left INVALID indexes behind: ${residue.join(", ")}`,
  );
});

test("the residue detector fires on a real failed CONCURRENTLY build", async () => {
  const table = "probe_0261_invalid_table";
  const probe = "probe_0261_invalid_residue";
  await db.execute(sql.raw(`DROP TABLE IF EXISTS ${table}`));
  try {
    await db.execute(sql.raw(`CREATE TABLE ${table} (id uuid primary key, org_id uuid, item_id uuid)`));
    await db.execute(
      sql.raw(`INSERT INTO ${table} (id, org_id, item_id) VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`),
    );
    // uuid text never parses as int, so the build fails on the row above and
    // leaves the name INVALID — the exact hazard 0261's cleanup exists for.
    const failed = await db
      .execute(sql.raw(`CREATE INDEX CONCURRENTLY ${probe} ON ${table} ((item_id::text::int))`))
      .then(
        () => null,
        (error) => error,
      );
    assert.ok(failed, "the poisoned build must fail");
    const residue = await invalidIndexes(db, [...LEDGER_TABLES, table]);
    assert.ok(
      residue.includes(probe),
      `the detector must name the failed build, got: ${residue.join(", ")}`,
    );
  } finally {
    await db.execute(sql.raw(`DROP TABLE IF EXISTS ${table}`));
  }
  const healed = await invalidIndexes(db, LEDGER_TABLES);
  assert.deepEqual(healed, [], "the probe must leave no residue behind");
});
