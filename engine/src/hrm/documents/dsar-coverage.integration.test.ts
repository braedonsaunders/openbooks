import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { DSAR_MODULES } from "./dsar.ts";
import { DSAR_EXCLUDED_TABLES, DSAR_GATHERED_TABLES } from "./dsar-coverage.ts";

// C-79 structural coverage. The person-linked surface is derived from the
// live catalog — foreign keys the database itself enforces, plus a name
// safety net for links the catalog does not constrain — never from a
// hand-kept list, so a new personal-data table fails here until
// dsar-coverage.ts decides: gather it, or exclude it with a reviewed
// reason. This discovery is deliberately self-contained: it must not
// import the registry's own filters, or the check would pass against
// itself. No skip guard: like the PII inventory test, a DB-owned test
// that self-skips turns CI red, so this fails loud without a database.

async function catalogPersonLinkedTables(): Promise<string[]> {
  // Catalog-proven links: a foreign key to a person table on any column
  // but the tenancy link (orgs are party rows, so org_id references
  // parties without the row being about a person).
  const fk = (await db.execute<{ table_name: string }>(sql`
    select distinct rel.relname as table_name
      from pg_constraint k
      join pg_class rel on rel.oid = k.conrelid
      join pg_namespace ns on ns.oid = rel.relnamespace
      join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
     where ns.nspname = 'public'
       and k.contype = 'f'
       and k.confrelid in ('public.parties'::regclass, 'public.worker_employments'::regclass, 'public.hrm_candidates'::regclass)
       and a.attname <> 'org_id'
  `)).rows.map((row) => row.table_name);
  // Name safety net for person links the catalog does not constrain
  // (incumbent/manager/report/subject employments, unlinked employment ids).
  const named = (await db.execute<{ table_name: string }>(sql`
    select distinct table_name
      from information_schema.columns
     where table_schema = 'public'
       and (column_name like '%\\_party\\_id' escape '\\'
            or column_name like '%\\_employment\\_id' escape '\\'
            or column_name in ('employment_id', 'candidate_id'))
  `)).rows.map((row) => row.table_name);
  return [...new Set([...fk, ...named])].sort();
}

async function catalogTables(): Promise<Set<string>> {
  const rows = (await db.execute<{ table_name: string }>(sql`
    select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
  `)).rows;
  return new Set(rows.map((row) => row.table_name));
}

test("every person-linked remit table has a gatherer or a reviewed exclusion", async () => {
  const discovered = await catalogPersonLinkedTables();
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

test("no gather-pending entries remain: subject data ships with its gatherer", async () => {
  const pending = DSAR_EXCLUDED_TABLES.filter((e) => e.reason.includes("gatherer pending")).map((e) => e.table);
  assert.deepEqual(pending, [], `subject-data tables with no DSAR gatherer: ${pending.join(", ")}`);
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
