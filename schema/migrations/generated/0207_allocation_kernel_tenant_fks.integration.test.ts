/// <reference types="node" />

/**
 * Live cover for 0207_allocation_kernel_tenant_fks — the allocation-kernel
 * tenant-FK repair.
 *
 * 0160's comment promised composite (org_id, id) FKs "where the parent
 * exposes (org_id, id)", then installed single-column edges for class,
 * journal_line, and book (plus source_journal_line, added composite by
 * 0207). A single-column edge lets one org's allocation target another
 * org's class, line, or book. 0207 preflights legacy violations by name,
 * backfills the parent (org_id, id) uniques, and replaces the edges with
 * DEFERRABLE composite keys.
 *
 * Asserted here through the live database, not the migration text: every
 * foreign key on the three kernel tables carries its organization, with the
 * four repaired edges spot-checked by name. Deliberately not asserted: the
 * 0160/0207 file spellings and preflight messages (published bytes,
 * protected by the bootstrap digest check), the reviewed-migration
 * registry (replaced by the migration-directory shape rule in
 * schema/canonical-baseline.test.ts), and the Drizzle mirror parity
 * (mirror FK lists have no runtime effect and no conformance backstop).
 *
 * Runs without a self-skip: the integration partition always provides a
 * database, so a missing one must fail loudly, never pass silently.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../../../engine/src/platform/db.ts";

const KERNEL_TABLES = ["allocation_rule_targets", "allocation_lineage", "allocation_runs"];

// The four edges 0207 repaired, spot-checked by name inside the derived
// sweep below: the repair's done-criteria, not an inventory.
const REPAIRED_EDGES = [
  { table: "allocation_rule_targets", name: "allocation_rule_targets_class_id_fkey" },
  { table: "allocation_lineage", name: "allocation_lineage_journal_line_id_fkey" },
  { table: "allocation_runs", name: "allocation_runs_book_id_fkey" },
  { table: "allocation_lineage", name: "allocation_lineage_source_journal_line_id_fkey" },
] as const;

async function singleColumnEdges(tables: readonly string[]): Promise<string[]> {
  const rows = await db.execute<{ edge: string }>(sql`
    select con.conname as edge
      from pg_constraint con
      join pg_class child on child.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = child.relnamespace
     where con.contype = 'f'
       and nsp.nspname = 'public'
       and child.relname in (${sql.join(
         tables.map((table) => sql`${table}`),
         sql`, `,
       )})
       and not exists (
         select 1
           from unnest(con.conkey) as key(attnum)
           join pg_attribute attr on attr.attrelid = child.oid
             and attr.attnum = key.attnum
             and attr.attname = 'org_id'
       )
     order by 1`);
  return rows.rows.map((row) => row.edge);
}

test("every allocation kernel foreign key carries its organization", async () => {
  const edges = await db.execute<{ name: string; columns: string }>(sql`
    select con.conname as name,
           (select string_agg(attr.attname, ',' order by key.ord)
              from unnest(con.conkey) with ordinality as key(attnum, ord)
              join pg_attribute attr on attr.attrelid = con.conrelid
                and attr.attnum = key.attnum) as columns
      from pg_constraint con
      join pg_class child on child.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = child.relnamespace
     where con.contype = 'f'
       and nsp.nspname = 'public'
       and child.relname in (${sql.join(
         KERNEL_TABLES.map((table) => sql`${table}`),
         sql`, `,
       )})
     order by 1`);
  assert.ok(edges.rows.length > 0, "the kernel tables must have foreign keys");
  const byName = new Map(edges.rows.map((row) => [row.name, row.columns ?? ""]));
  for (const edge of REPAIRED_EDGES) {
    const columns = byName.get(edge.name);
    assert.ok(columns, `the repaired edge ${edge.name} must exist`);
    assert.ok(
      columns.startsWith("org_id,"),
      `${edge.name} must stay composite (org_id, ...), got (${columns})`,
    );
  }
  const single = await singleColumnEdges(KERNEL_TABLES);
  assert.deepEqual(single, [], `single-column kernel edges would cross organizations: ${single.join(", ")}`);
});

test("the edge detector fires on a planted single-column edge", async () => {
  const table = "probe_0207_single_edge";
  await db.execute(sql.raw(`DROP TABLE IF EXISTS ${table}`));
  try {
    await db.execute(
      sql.raw(`CREATE TABLE ${table} (id uuid primary key, org_id uuid, class_id uuid references classes(id))`),
    );
    const single = await singleColumnEdges([...KERNEL_TABLES, table]);
    assert.ok(
      single.some((edge) => edge.includes(table)),
      `the detector must name the planted edge, got: ${single.join(", ")}`,
    );
  } finally {
    await db.execute(sql.raw(`DROP TABLE IF EXISTS ${table}`));
  }
});
