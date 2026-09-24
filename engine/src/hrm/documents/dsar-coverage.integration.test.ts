import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { DSAR_MODULES } from "./dsar.ts";
import {
  DSAR_EXCLUDED_TABLES,
  DSAR_GATHERED_TABLES,
  DSAR_PERSON_LINK_COLUMNS,
  DSAR_REMIT_EXTRA_TABLES,
} from "./dsar-coverage.ts";

// C-79 structural coverage. The person-linked surface is derived from the
// live catalog — the same information_schema the database itself enforces —
// never from a hand-kept list, so a new personal-data table fails here
// until dsar-coverage.ts decides: gather it, or exclude it with a reviewed
// reason. No skip guard: like the PII inventory test, a DB-owned test that
// self-skips turns CI red, so this fails loud without a database.

async function remitPersonLinkedTables(): Promise<string[]> {
  const rows = (await db.execute<{ table_name: string }>(sql`
    select distinct c.table_name
      from information_schema.columns c
     where c.table_schema = 'public'
       and c.column_name in (${sql.join(
         DSAR_PERSON_LINK_COLUMNS.map((column) => sql`${column}`),
         sql`, `,
       )})
       and (c.table_name like 'hrm\\_%' escape '\\'
            or c.table_name in (${sql.join(
              DSAR_REMIT_EXTRA_TABLES.map((table) => sql`${table}`),
              sql`, `,
            )}))
     order by 1
  `)).rows;
  return rows.map((row) => row.table_name);
}

async function catalogTables(): Promise<Set<string>> {
  const rows = (await db.execute<{ table_name: string }>(sql`
    select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
  `)).rows;
  return new Set(rows.map((row) => row.table_name));
}

test("every person-linked remit table has a gatherer or a reviewed exclusion", async () => {
  const discovered = await remitPersonLinkedTables();
  assert.ok(discovered.length > 0, "the discovery query must see the HR surface");
  const covered = new Set([
    ...DSAR_GATHERED_TABLES.map((entry) => entry.table),
    ...DSAR_EXCLUDED_TABLES.map((entry) => entry.table),
  ]);
  const undecided = discovered.filter((table) => !covered.has(table));
  assert.deepEqual(
    undecided,
    [],
    `personal-data tables with no DSAR decision (gather in dsar.ts and list in dsar-coverage.ts, or exclude with a reason): ${undecided.join(", ")}`,
  );
});

test("the registry names real tables only", async () => {
  const catalog = await catalogTables();
  const stale = [...DSAR_GATHERED_TABLES.map((entry) => entry.table), ...DSAR_EXCLUDED_TABLES.map((entry) => entry.table)].filter(
    (table) => !catalog.has(table),
  );
  assert.deepEqual(stale, [], `coverage registry entries with no such table: ${stale.join(", ")}`);
});

test("gathered domains are real DSAR modules, and every module is represented", async () => {
  const modules = new Set<string>(DSAR_MODULES);
  const orphaned = [...new Set(DSAR_GATHERED_TABLES.map((entry) => entry.domain))].filter(
    (domain) => !modules.has(domain),
  );
  assert.deepEqual(orphaned, [], `coverage domains with no DSAR module: ${orphaned.join(", ")}`);
  const unrepresented = (DSAR_MODULES as readonly string[]).filter(
    (module) => !DSAR_GATHERED_TABLES.some((entry) => entry.domain === module),
  );
  assert.deepEqual(unrepresented, [], `DSAR modules gathering no inventoried table: ${unrepresented.join(", ")}`);
});
