import { sql } from "drizzle-orm";
import { db } from "../db.ts";

/**
 * Catalog introspection for the clone engine. Rather than hardcode 119 tables,
 * we read the live Postgres catalog: the set of tenant tables is "every base
 * table with an org_id column", and the FK graph comes from pg_constraint. This
 * makes the clone engine self-maintaining — new tables that follow the orgRef
 * convention are cloned automatically.
 */

/** org-less child tables that still belong to a tenant via a parent, so they
 * must be rebased too. Each needs a bespoke source filter (see PARENT_FILTER). */
const EXTRA_REBASE = ["file_versions", "file_blobs", "tax_group_members"] as const;

/** Nullable back-links cleared only inside the guarded sandbox-wipe transaction
 * to break genuine NO ACTION cycles before immediate FK-ordered deletion. */
export const SANDBOX_CYCLE_BREAKERS: Record<string, readonly string[]> = {
  documents: ["posted_entry_id"],
  payment_schedules: ["last_payment_run_id"],
  time_entries: ["invoiced_by_line_id"],
};

/** Tables never copied into a sandbox: sandbox-management tables, real-world
 * logs (would carry production PII/history), and the org row itself (created
 * explicitly by the clone). */
const EXCLUDE = new Set([
  "orgs",
  "sandboxes",
  "masking_policies",
  "change_sets",
  "change_set_items",
  "email_log",
  "audit_log",
  "api_key_events",
  "intercompany_pairs",
]);

/** Source-row filter for the org-less rebased tables (they have no org_id). */
export const PARENT_FILTER: Record<string, (prodOrg: string) => string> = {
  file_versions: (o) =>
    `file_id in (select id from files where org_id = '${o}')`,
  file_blobs: (o) =>
    `version_id in (select fv.id from file_versions fv join files f on f.id = fv.file_id where f.org_id = '${o}')`,
  tax_group_members: (o) =>
    `tax_group_id in (select id from tax_groups where org_id = '${o}')`,
};

export interface ColumnInfo {
  name: string;
  isUuid: boolean;
}

export interface TableInfo {
  name: string;
  hasOrgId: boolean;
  hasId: boolean;
  columns: ColumnInfo[];
  /** column name → referenced table (foreign keys). */
  fks: Record<string, string>;
  /** column name → FK ON DELETE rule (NO ACTION, RESTRICT, CASCADE, ...). */
  fkDeleteRules: Record<string, string>;
}

export interface Catalog {
  /** Tables the clone engine copies, in no particular order (FKs are deferred). */
  tables: TableInfo[];
  /** Every tenant-owned table that can contain sandbox rows, including tables
   * intentionally not copied from production. */
  tenantTables: TableInfo[];
  /** Fast membership test: is this table rebased (its ids remapped)? */
  rebaseSet: Set<string>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Guard against SQL injection when inlining server-generated ids into DDL. */
export function assertUuid(v: string): string {
  if (!UUID_RE.test(v)) throw new Error(`not a uuid: ${v}`);
  return v;
}

export async function loadCatalog(): Promise<Catalog> {
  // Columns for every base table in public, flagged as uuid or not.
  const colsRes = (await db.execute(sql`
    select c.table_name, c.column_name, c.data_type, c.udt_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_name = c.table_name and t.table_schema = c.table_schema
     where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
     order by c.table_name, c.ordinal_position`)) as any;

  // Foreign-key edges: (table, column) → referenced table + delete behavior.
  const fkRes = (await db.execute(sql`
    select tc.table_name, kcu.column_name, ccu.table_name as ref_table,
           rc.delete_rule
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
      join information_schema.constraint_column_usage ccu
        on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
      join information_schema.referential_constraints rc
        on rc.constraint_name = tc.constraint_name and rc.constraint_schema = tc.table_schema
     where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'`)) as any;

  const byTable = new Map<string, TableInfo>();
  for (const r of colsRes.rows as any[]) {
    let t = byTable.get(r.table_name);
    if (!t) {
      t = {
        name: r.table_name,
        hasOrgId: false,
        hasId: false,
        columns: [],
        fks: {},
        fkDeleteRules: {},
      };
      byTable.set(r.table_name, t);
    }
    const isUuid = r.udt_name === "uuid";
    t.columns.push({ name: r.column_name, isUuid });
    if (r.column_name === "org_id") t.hasOrgId = true;
    if (r.column_name === "id") t.hasId = true;
  }
  for (const r of fkRes.rows as any[]) {
    const t = byTable.get(r.table_name);
    if (t) {
      t.fks[r.column_name] = r.ref_table;
      t.fkDeleteRules[r.column_name] = r.delete_rule;
    }
  }

  // Tenant set = every org-owned table + org-less children. Rebase set is the
  // cloneable subset; clone exclusions can still gain sandbox-owned rows later
  // and therefore remain in tenantTables for deletion.
  const tenantSet = new Set<string>();
  for (const t of byTable.values()) if (t.hasOrgId) tenantSet.add(t.name);
  for (const e of EXTRA_REBASE) if (byTable.has(e)) tenantSet.add(e);
  const rebaseSet = new Set(tenantSet);
  for (const e of EXCLUDE) rebaseSet.delete(e);

  const tables = [...rebaseSet].map((n) => byTable.get(n)!).filter(Boolean);
  const tenantTables = [...tenantSet].map((n) => byTable.get(n)!).filter(Boolean);
  return { tables, tenantTables, rebaseSet };
}

/**
 * Safe DELETE order for wiping an org: a table that references another is
 * deleted BEFORE the table it points at (referencers first). Required because
 * some FKs are ON DELETE RESTRICT (e.g. custom_records → custom_record_types),
 * which is non-deferrable and blocks deleting the parent while children exist.
 * Kahn's topological sort on edges "A references B"; reference cycles (all
 * NO ACTION / deferrable) are appended last and resolved by deferred checks.
 * Self-references are excluded here — callers pre-null those columns.
 */
export function deletionOrder(cat: Catalog): string[] {
  const names = cat.tables.map((t) => t.name);
  const inSet = new Set(names);
  const deps = new Map<string, Set<string>>();
  const indeg = new Map<string, number>();
  for (const n of names) {
    deps.set(n, new Set());
    indeg.set(n, 0);
  }
  for (const t of cat.tables) {
    for (const [column, ref] of Object.entries(t.fks)) {
      const rule = t.fkDeleteRules[column];
      if (rule === "CASCADE" || rule === "SET NULL") continue;
      if (SANDBOX_CYCLE_BREAKERS[t.name]?.includes(column)) continue;
      if (ref === t.name || !inSet.has(ref)) continue;
      if (!deps.get(t.name)!.has(ref)) {
        deps.get(t.name)!.add(ref);
        indeg.set(ref, (indeg.get(ref) ?? 0) + 1);
      }
    }
  }
  const queue = names.filter((n) => (indeg.get(n) ?? 0) === 0);
  const order: string[] = [];
  const seen = new Set<string>();
  while (queue.length) {
    const n = queue.shift()!;
    if (seen.has(n)) continue;
    seen.add(n);
    order.push(n);
    for (const b of deps.get(n) ?? []) {
      indeg.set(b, (indeg.get(b) ?? 0) - 1);
      if ((indeg.get(b) ?? 0) === 0) queue.push(b);
    }
  }
  for (const n of names) if (!seen.has(n)) order.push(n);

  return order;
}

/** Tables left after Kahn's acyclic pass. Their FK graph contains a cycle (or
 * depends on one), so only this tail needs deferred constraint checking during
 * a sandbox wipe. */
export function deferredDeletionTables(cat: Catalog): Set<string> {
  const names = cat.tables.map((t) => t.name);
  const inSet = new Set(names);
  const indeg = new Map(names.map((name) => [name, 0]));
  const deps = new Map(names.map((name) => [name, new Set<string>()]));
  for (const t of cat.tables) {
    for (const [column, ref] of Object.entries(t.fks)) {
      const rule = t.fkDeleteRules[column];
      if (rule === "CASCADE" || rule === "SET NULL") continue;
      if (SANDBOX_CYCLE_BREAKERS[t.name]?.includes(column)) continue;
      if (ref === t.name || !inSet.has(ref) || deps.get(t.name)!.has(ref)) continue;
      deps.get(t.name)!.add(ref);
      indeg.set(ref, (indeg.get(ref) ?? 0) + 1);
    }
  }
  const queue = names.filter((name) => (indeg.get(name) ?? 0) === 0);
  const seen = new Set<string>();
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    for (const ref of deps.get(name) ?? []) {
      indeg.set(ref, (indeg.get(ref) ?? 0) - 1);
      if ((indeg.get(ref) ?? 0) === 0) queue.push(ref);
    }
  }
  const deferred = new Set(names.filter((name) => !seen.has(name)));
  return deferred;
}

/** Self-referential ON DELETE RESTRICT columns per table. Those must be
 * pre-nulled before an org wipe because RESTRICT is checked immediately.
 * Deferred NO ACTION references must stay intact: nulling them can violate
 * root-only partial unique indexes (for example subsidiaries). */
export function selfRefColumns(t: TableInfo): string[] {
  return Object.entries(t.fks)
    .filter(([col, ref]) => ref === t.name && t.fkDeleteRules[col] === "RESTRICT")
    .map(([col]) => col);
}
