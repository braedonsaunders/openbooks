/// <reference types="node" />

/**
 * Tenant-coherent foreign keys, asserted through the live catalog.
 *
 * A single-column edge lets one organization's row point at another
 * organization's parent. The allocation kernel tables carry their
 * organization on every foreign key; inventory provisional costs pin their
 * legal entity to the issuing movement's entity; a price schedule can
 * supersede only a schedule of its own organization. Each guard must be a
 * validated composite key that leads with org_id.
 *
 * Runs without a self-skip: the integration partition always provides a
 * database, so a missing one must fail loudly, never pass silently.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";

const KERNEL_TABLES = ["allocation_rule_targets", "allocation_lineage", "allocation_runs"];

const COMPOSITE_EDGES = [
  {
    table: "allocation_rule_targets",
    name: "allocation_rule_targets_class_id_fkey",
    columns: "org_id,class_id",
  },
  {
    table: "allocation_lineage",
    name: "allocation_lineage_journal_line_id_fkey",
    columns: "org_id,journal_line_id",
  },
  {
    table: "allocation_lineage",
    name: "allocation_lineage_source_journal_line_id_fkey",
    columns: "org_id,source_journal_line_id",
  },
  { table: "allocation_runs", name: "allocation_runs_book_id_fkey", columns: "org_id,book_id" },
  {
    table: "inventory_provisional_costs",
    name: "inv_provisional_org_subsidiary_fk",
    columns: "org_id,subsidiary_id",
  },
  {
    table: "inventory_provisional_costs",
    name: "inv_provisional_issue_movement_entity_fk",
    columns: "org_id,subsidiary_id,issue_movement_id",
  },
  {
    table: "item_price_schedules",
    name: "item_price_schedule_supersedes_fk",
    columns: "org_id,supersedes_id",
  },
] as const;

type Edge = { table: string; name: string; columns: string; validated: boolean };

async function foreignKeys(tables: readonly string[]): Promise<Edge[]> {
  return await db.execute<Edge>(
    sql`
    select child.relname as "table",
           con.conname as name,
           con.convalidated as validated,
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
         tables.map((table) => sql`${table}`),
         sql`, `,
       )})
     order by 1, 2`,
    "objects",
  );
}

function withoutOrganization(edges: readonly Edge[]): string[] {
  return edges
    .filter((edge) => !(edge.columns ?? "").split(",").includes("org_id"))
    .map((edge) => edge.name);
}

test("tenant-scoped parents are referenced through validated (org_id, ...) keys", async () => {
  const edges = await foreignKeys([...new Set(COMPOSITE_EDGES.map((edge) => edge.table))]);
  const byName = new Map(edges.map((edge) => [edge.name, edge]));
  for (const expected of COMPOSITE_EDGES) {
    const edge = byName.get(expected.name);
    assert.ok(edge, `${expected.name} must exist on ${expected.table}`);
    assert.equal(edge.table, expected.table);
    assert.equal(edge.columns, expected.columns, `${expected.name} must stay composite`);
    assert.equal(edge.validated, true, `${expected.name} must be validated`);
  }
});

test("every allocation kernel foreign key carries its organization", async () => {
  const edges = await foreignKeys(KERNEL_TABLES);
  assert.ok(edges.length > 0, "the kernel tables must have foreign keys");
  const single = withoutOrganization(edges);
  assert.deepEqual(
    single,
    [],
    `single-column kernel edges would cross organizations: ${single.join(", ")}`,
  );
});

test("the edge detector fires on a planted single-column edge", async () => {
  const table = "probe_single_column_edge";
  await db.execute(sql.raw(`DROP TABLE IF EXISTS ${table}`));
  try {
    await db.execute(
      sql.raw(
        `CREATE TABLE ${table} (id uuid primary key, org_id uuid, class_id uuid references classes(id))`,
      ),
    );
    const single = withoutOrganization(await foreignKeys([...KERNEL_TABLES, table]));
    assert.ok(
      single.some((edge) => edge.includes(table)),
      `the detector must name the planted edge, got: ${single.join(", ")}`,
    );
  } finally {
    await db.execute(sql.raw(`DROP TABLE IF EXISTS ${table}`));
  }
});
