import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { PROJECT_MERGE_EXCLUSIONS, PROJECT_REFS } from "./merge.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

// B-PRJ-03: a hand-maintained reference list can only omit. Every typed
// project_id column in the catalog must either move with the merge
// (PROJECT_REFS, each with its both-sides collision guard where storage
// keys collide) or carry an explicit reviewed exclusion naming why
// (PROJECT_MERGE_EXCLUSIONS). Foreign keys to projects agree: the only
// project-linked column that is neither a project_id move nor an exclusion
// is projects.parent_id, which the merge handles as hierarchy, not as a
// reference row.

test("project merge covers every catalog project_id column or excludes it by review", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const columns = (
      await db.execute<{ table_name: string; column_name: string }>(sql`
        select c.table_name, c.column_name
          from information_schema.columns c
         where c.table_schema = 'public' and c.column_name = 'project_id'
         order by 1`)
    ).rows;
    assert.ok(columns.length > 30, "catalog enumeration returned a plausible project_id population");
    const refs = new Map(PROJECT_REFS.map(([table, column]) => [`${table}.${column}`, table]));
    const exclusions = new Map(PROJECT_MERGE_EXCLUSIONS);
    for (const [table, reason] of PROJECT_MERGE_EXCLUSIONS) {
      assert.ok(reason.length > 50, `${table} exclusion carries a reviewed reason, not a stub`);
    }
    const uncovered = columns.filter(
      (row) => !refs.has(`${row.table_name}.${row.column_name}`) && !exclusions.has(row.table_name),
    );
    assert.deepEqual(
      uncovered.map((row) => `${row.table_name}.${row.column_name}`),
      [],
    );
    // No stale entries either: every listed table still carries the column.
    const catalogTables = new Set(columns.map((row) => row.table_name));
    for (const [table] of PROJECT_REFS) {
      assert.ok(catalogTables.has(table), `${table} is listed but has no project_id column`);
    }
    for (const [table] of PROJECT_MERGE_EXCLUSIONS) {
      assert.ok(catalogTables.has(table), `${table} is excluded but has no project_id column`);
    }
    // The FK derivation agrees: the only project-linked column outside the
    // project_id population is the hierarchy parent, handled separately.
    const fkColumns = (
      await db.execute<{ table_name: string; column_name: string }>(sql`
        select t.relname::text as table_name, a.attname::text as column_name
          from pg_constraint c
          join pg_class t on t.oid = c.conrelid
          join pg_namespace n on n.oid = t.relnamespace
          join lateral unnest(c.conkey) with ordinality as k(attnum, ord) on true
          join lateral unnest(c.confkey) with ordinality as fk(attnum, ord) on fk.ord = k.ord
          join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
          join pg_attribute fa on fa.attrelid = c.confrelid and fa.attnum = fk.attnum
         where n.nspname = 'public' and c.contype = 'f'
           and c.confrelid = 'projects'::regclass and fa.attname = 'id'`)
    ).rows;
    const projectIdSet = new Set(columns.map((row) => `${row.table_name}.${row.column_name}`));
    assert.deepEqual(
      fkColumns
        .filter((row) => !projectIdSet.has(`${row.table_name}.${row.column_name}`))
        .map((row) => `${row.table_name}.${row.column_name}`),
      ["projects.parent_id"],
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
