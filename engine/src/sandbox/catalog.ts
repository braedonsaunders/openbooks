import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { TENANT_TABLE_POLICIES, type TenantTablePolicy } from "./tenant-table-policies.ts";

/**
 * Catalog introspection for the clone engine. The live Postgres catalog
 * supplies tenant tables and FK dependencies; tenant-table-policies.ts requires
 * each discovered tenant table to be explicitly classified for copy/skip and
 * identifier rebasing before a clone may proceed.
 */

/** org-less child tables that still belong to a tenant via a parent, so they
 * must be rebased too. Each needs a bespoke source filter (see PARENT_FILTER). */
export const EXTRA_REBASE = ["file_versions", "file_blobs", "tax_group_members"] as const;

/** Nullable back-links cleared only inside the guarded sandbox-wipe transaction
 * to break genuine NO ACTION cycles before immediate FK-ordered deletion. */
export const SANDBOX_CYCLE_BREAKERS: Record<string, readonly string[]> = {
  documents: ["posted_entry_id"],
  payment_schedules: ["last_payment_run_id"],
  time_entries: ["invoiced_by_line_id"],
};

/**
 * Trigger-enforced ownership references that are intentionally not backed by
   * ordinary foreign keys. They still constrain bulk INSERT order because the
 * BEFORE trigger resolves the referenced row immediately. Keep this map small
 * and explicit: inferred references without an enforcing trigger must not
 * reintroduce the deferrable documents↔journal_entries cycle.
 */
const TRIGGER_INSERT_COLUMN_PARENTS: Readonly<Record<string, string>> = {
  subsidiary_id: "subsidiaries",
};
const TRIGGER_INSERT_TABLE_PARENTS: Readonly<Record<string, readonly string[]>> = {
  // Cross-row checks in field_ticket_labor_line_integrity_guard read these
  // parents immediately. Several related tables participate in deferrable FK
  // cycles, so their trigger dependencies must also order the cyclic tail.
  field_ticket_labor_lines: [
    "field_ticket_labor_snapshots",
    "documents",
    "parties",
    "items",
    "time_types",
    "project_tasks",
    "users",
    "time_entries",
  ],
};

/** Tables never copied into a sandbox: sandbox-management tables, real-world
 * logs (would carry production PII/history), and the org row itself (created
 * explicitly by the clone). */
export const EXCLUDE = new Set([
  "orgs",
  "sandboxes",
  "masking_policies",
  "change_sets",
  "change_set_items",
  "email_log",
  "audit_log",
  "api_key_events",
  "intercompany_pairs",
  // Credential material is never copied. api_keys.key_hash and
  // sftp_servers.username sit in GLOBAL unique indexes (api_keys_hash,
  // sftp_servers_username_global) because the API/SFTP front doors route a
  // credential to its tenant without an org predicate — so a verbatim copy
  // either collides (23505, failing every clone of an org that ever minted a
  // key) or, worse, would resolve a production credential to the sandbox.
  // Import schedules hang off SFTP servers and go with them. neuterSandbox
  // still deactivates any rows that reach a sandbox by other means.
  "api_keys",
  "sftp_servers",
  "sftp_import_schedules",
  // A sandbox must not inherit production's backup schedule, and its run
  // ledger must not reference production's S3 objects (a delete inside the
  // sandbox would remove production's backup). Sandboxes start backup-free.
  "backup_policies",
  "backup_runs",
  // Derived GL aggregate — the journal triggers rebuild it while the clone
  // copies entries and lines, so copying it too would double-count.
  "gl_month_activity",
  // Derived settlement-behaviour rollup — the applications trigger
  // repopulates it as the settlements are copied.
  "party_payment_stats",
  // Executable scheduler work is never copied. scheduler_outbox carries a
  // GLOBAL unique on (kind, occurrence_key), so copying an org-bound row
  // verbatim collides with the source's own row (PG 23505 on
  // scheduler_outbox_occurrence, deterministic for any template with
  // scheduler rows, OM-13b) — and a sample or sandbox must never replay the
  // source's side effects. The terminal audit hangs off the outbox rows and
  // goes with them.
  "scheduler_outbox",
  "scheduler_outbox_terminal_audit",
  // Bearer-equivalent tokens are never copied: like api_keys.key_hash, a
  // verbatim copy either collides on a global unique (invitation token_hash,
  // kiosk device_token_hash) or resolves a production credential to the
  // sandbox. Invitation, payment-link, signature and kiosk flows are
  // re-issued inside the sandbox, never carried over. OM-13-CLONE: document
  // signing links are the same shape — hrm_document_signers.token_hash is a
  // global unique routed by an org-less lookup, so any template with
  // in-flight signatures dies with PG 23505 on the copy.
  "payment_links",
  "field_ticket_signature_requests",
  "hrm_survey_invitations",
  "hrm_document_signers",
  "time_kiosks",
]);

/**
 * Escape hatch for uuid `*_id` columns that must survive a clone UNCHANGED —
 * references to rows that are shared rather than copied per tenant. Everything
 * else with no derivable target is rebased, because keeping the source org's id
 * is a cross-tenant reference and always wrong.
 */
export const UNREBASED_REFS: ReadonlySet<string> = new Set<string>([]);

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
  /** Postgres type name (information_schema udt_name), e.g. uuid, text, jsonb. */
  udtName: string;
  isNullable: boolean;
}

export interface TableInfo {
  name: string;
  hasOrgId: boolean;
  hasId: boolean;
  columns: ColumnInfo[];
  /** column name → referenced table (foreign keys + inferred references). */
  fks: Record<string, string>;
  /** column name → FK ON DELETE rule (NO ACTION, RESTRICT, CASCADE, ...). */
  fkDeleteRules: Record<string, string>;
  /**
   * column → referenced table for REAL, NON-DEFERRABLE foreign keys only. These
   * are the FKs that constrain INSERT order (deferrable ones resolve at commit;
   * inferred references have no constraint at all). Drives insertionOrder.
   */
  hardFks: Record<string, string>;
  /**
   * uuid columns that MUST be rebased even without a resolvable FK — they sit in a
   * unique index that omits org_id, so copying the prod value verbatim collides with
   * prod's own row. Covers polymorphic references (subject_id, target_value_id) whose
   * target can't be named; ob_rebase(same seed) maps them to the sandbox row anyway.
   */
  forceRebase: Set<string>;
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
  // GENERATED ALWAYS columns are readable projections, never insertable: the
  // clone names every column it copies (`insert into t (cols) select ...`), so
  // naming one makes PostgreSQL refuse the whole table with "cannot insert a
  // non-DEFAULT value into column". They are recomputed by the target row from
  // the columns that are copied. Every enumeration that feeds a write must
  // declare this stance (engine/src/testing/column-enumerations.ts).
  const colsRes = await db.execute<{
    table_name: string; column_name: string; udt_name: string; is_nullable: string;
  }>(sql`
    select c.table_name, c.column_name, c.data_type, c.udt_name, c.is_nullable
      from information_schema.columns c
      join information_schema.tables t
        on t.table_name = c.table_name and t.table_schema = c.table_schema
     where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
       and c.is_generated = 'NEVER'
     order by c.table_name, c.ordinal_position`);

  // Foreign-key edges: (table, column) → referenced table + delete behavior.
  // Use pg_catalog OIDs, not the information_schema constraint-name joins.
  // Constraint names are only table-local; joining them by name multiplies
  // common generated names across a large ERP catalog and made sandbox
  // provisioning spend minutes in introspection.
  const fkRes = await db.execute<{
    table_name: string; column_name: string; ref_table: string; delete_rule: string; is_deferrable: string;
  }>(sql`
    select source.relname as table_name,
           source_column.attname as column_name,
           target.relname as ref_table,
           case con.confdeltype
             when 'a' then 'NO ACTION'
             when 'r' then 'RESTRICT'
             when 'c' then 'CASCADE'
             when 'n' then 'SET NULL'
             when 'd' then 'SET DEFAULT'
           end as delete_rule,
           case when con.condeferrable then 'YES' else 'NO' end
             as is_deferrable
      from pg_constraint con
      join pg_class source on source.oid = con.conrelid
      join pg_namespace source_namespace
        on source_namespace.oid = source.relnamespace
      join pg_class target on target.oid = con.confrelid
      cross join lateral generate_subscripts(con.conkey, 1) position
      join pg_attribute source_column
        on source_column.attrelid = con.conrelid
       and source_column.attnum = con.conkey[position]
     where con.contype = 'f'
       and source_namespace.nspname = 'public'
     order by source.relname, con.conname, position`);

  const byTable = new Map<string, TableInfo>();
  for (const r of colsRes.rows) {
    let t = byTable.get(r.table_name);
    if (!t) {
      t = {
        name: r.table_name,
        hasOrgId: false,
        hasId: false,
        columns: [],
        fks: {},
        fkDeleteRules: {},
        hardFks: {},
        forceRebase: new Set<string>(),
      };
      byTable.set(r.table_name, t);
    }
    const isUuid = r.udt_name === "uuid";
    t.columns.push({
      name: r.column_name,
      isUuid,
      udtName: r.udt_name,
      isNullable: r.is_nullable === "YES",
    });
    if (r.column_name === "org_id") t.hasOrgId = true;
    if (r.column_name === "id") t.hasId = true;
  }
  for (const r of fkRes.rows) {
    const t = byTable.get(r.table_name);
    if (t) {
      t.fks[r.column_name] = r.ref_table;
      t.fkDeleteRules[r.column_name] = r.delete_rule;
      if (r.is_deferrable !== "YES") t.hardFks[r.column_name] = r.ref_table;
    }
  }

  // uuid columns inside a UNIQUE index that omits org_id — must be force-rebased or
  // the copy collides with prod's own row (the key is global, not per-tenant).
  const uqRes = await db.execute<{ table_name: string; column_name: string }>(sql`
    select ix.indrelid::regclass::text as table_name, a.attname as column_name
      from pg_index ix
      join pg_attribute a on a.attrelid = ix.indrelid and a.attnum = any(ix.indkey)
     where ix.indisunique and a.atttypid = 'uuid'::regtype
       and exists (select 1 from pg_attribute o where o.attrelid = ix.indrelid and o.attname = 'org_id' and not o.attisdropped)
       and not exists (select 1 from pg_attribute o2 join lateral unnest(ix.indkey) kk(n) on o2.attnum = kk.n
                        where o2.attrelid = ix.indrelid and o2.attname = 'org_id')`);
  for (const r of uqRes.rows) {
    const t = byTable.get(r.table_name);
    if (t && r.column_name !== "id" && r.column_name !== "org_id") t.forceRebase.add(r.column_name);
  }

  // Tenant set = every org-owned table + org-less children. Rebase set is the
  // cloneable subset; clone exclusions can still gain sandbox-owned rows later
  // and therefore remain in tenantTables for deletion.
  const tenantSet = new Set<string>();
  for (const t of byTable.values()) if (t.hasOrgId) tenantSet.add(t.name);
  for (const e of EXTRA_REBASE) if (byTable.has(e)) tenantSet.add(e);
  const policies = TENANT_TABLE_POLICIES as Record<string, TenantTablePolicy>;
  const unclassified = [...tenantSet].filter((name) => !policies[name]);
  const stale = Object.keys(policies).filter((name) => !tenantSet.has(name));
  if (unclassified.length || stale.length) {
    throw new Error(
      `sandbox clone table policy is out of date; classify new tenant tables (${unclassified.join(", ") || "none"}) ` +
      `and remove retired tables (${stale.join(", ") || "none"})`,
    );
  }
  const policySkips = new Set(Object.entries(policies)
    .filter(([, policy]) => policy === "skip:no-copy")
    .map(([name]) => name));
  const tenantExclusions = new Set([...EXCLUDE].filter((name) => tenantSet.has(name)));
  const exclusionDrift = [...new Set([...tenantExclusions, ...policySkips])]
    .filter((name) => tenantExclusions.has(name) !== policySkips.has(name));
  if (exclusionDrift.length) {
    throw new Error(`sandbox clone skip policies disagree with exclusion rationale for: ${exclusionDrift.join(", ")}`);
  }
  const parentFilterDrift = [...tenantSet].filter((name) =>
    (policies[name] === "clone:parent-filter") !== (name in PARENT_FILTER));
  if (parentFilterDrift.length) {
    throw new Error(`sandbox clone parent-filter policies disagree for: ${parentFilterDrift.join(", ")}`);
  }
  const rebaseSet = new Set([...tenantSet].filter((name) => policies[name] !== "skip:no-copy"));

  // Infer references for uuid `<name>_id` columns that carry NO foreign-key
  // constraint (schema drift left many internal references unconstrained — e.g.
  // document_line_tax_components.document_line_id, document_lines.project_id).
  // Without rebasing them the clone copies prod ids verbatim: usually a silently
  // corrupt reference, and a hard duplicate-key error where a unique index omits
  // org_id (the copied prod key collides with prod's own row). Rebase iff the
  // inferred target is a table we actually clone. Only fills gaps — real FKs win.
  const allTables = new Set(byTable.keys());
  const plural = (s: string) => (s.endsWith("s") ? s : s.endsWith("y") ? s.slice(0, -1) + "ies" : s + "s");
  const inferRef = (col: string): string | null => {
    const base = col.slice(0, -3); // strip "_id"
    const last = base.split("_").pop()!;
    for (const cand of [plural(base), base, plural(last), last]) {
      if (allTables.has(cand)) return cand;
    }
    return null;
  };
  for (const t of byTable.values()) {
    if (!rebaseSet.has(t.name)) continue;
    for (const c of t.columns) {
      if (!c.isUuid || c.name === "id" || c.name === "org_id" || t.fks[c.name] || !c.name.endsWith("_id")) continue;
      const ref = inferRef(c.name);
      if (ref && rebaseSet.has(ref)) {
        t.fks[c.name] = ref;
        t.fkDeleteRules[c.name] = "NO ACTION";
        continue;
      }
      // Whatever is left is a reference whose target cannot be derived from its
      // name — polymorphic columns like labor_rate_version_scopes.scope_value_id
      // or resource_grants.resource_id. Copying such a value verbatim leaves the
      // sandbox POINTING AT THE SOURCE ORG'S ROW: a silent cross-tenant
      // reference that reads as valid configuration. Rebasing needs no target
      // table — ob_rebase is a pure function of (id, seed), so it maps any
      // cloned row's id to its counterpart. Rebase, and treat the rare pointer
      // to something not cloned as the dangling reference it already was.
      if (!UNREBASED_REFS.has(`${t.name}.${c.name}`)) t.forceRebase.add(c.name);
    }
  }

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

/**
 * Safe INSERT order for cloning an org: a referenced table (parent) is copied
 * BEFORE any table that references it (child). Required because 152 of the FKs are
 * NON-DEFERRABLE, so `set constraints all deferred` can't save an out-of-order
 * insert — the check fires immediately. Unlike deletionOrder this considers ALL FK
 * edges (delete rule is irrelevant to an INSERT check), excluding self-references
 * and declared cycle-breakers. Inferred UUID references also participate: a
 * growing number are enforced by ownership triggers rather than foreign keys,
 * and those BEFORE triggers require their parent to exist at statement time.
 * The declared breaker on documents.posted_entry_id opens the intentional
 * documents↔journal_entries cycle; the deferred constraint validates it at
 * commit after both sides exist.
 */
export function insertionOrder(cat: Catalog): string[] {
  const names = cat.tables.map((t) => t.name);
  const inSet = new Set(names);
  const children = new Map<string, Set<string>>(); // parent → children that must follow it
  const indeg = new Map<string, number>(); // # of unresolved parents per child
  for (const n of names) {
    children.set(n, new Set());
    indeg.set(n, 0);
  }
  for (const t of cat.tables) {
    // Include inferred references as well as real FKs. Trigger-enforced tenant
    // ownership is just as immediate as a non-deferrable FK during bulk copy.
    // Explicit cycle breakers are the only references intentionally deferred.
    for (const [column, ref] of Object.entries(t.fks)) {
      if (ref === t.name || !inSet.has(ref)) continue;
      if (SANDBOX_CYCLE_BREAKERS[t.name]?.includes(column)) continue;
      if (!children.get(ref)!.has(t.name)) {
        children.get(ref)!.add(t.name);
        indeg.set(t.name, (indeg.get(t.name) ?? 0) + 1);
      }
    }
    for (const column of t.columns) {
      const ref = TRIGGER_INSERT_COLUMN_PARENTS[column.name];
      if (!ref || ref === t.name || !inSet.has(ref)) continue;
      if (!children.get(ref)!.has(t.name)) {
        children.get(ref)!.add(t.name);
        indeg.set(t.name, (indeg.get(t.name) ?? 0) + 1);
      }
    }
    for (const ref of TRIGGER_INSERT_TABLE_PARENTS[t.name] ?? []) {
      if (ref === t.name || !inSet.has(ref)) continue;
      if (!children.get(ref)!.has(t.name)) {
        children.get(ref)!.add(t.name);
        indeg.set(t.name, (indeg.get(t.name) ?? 0) + 1);
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
    for (const child of children.get(n) ?? []) {
      indeg.set(child, (indeg.get(child) ?? 0) - 1);
      if ((indeg.get(child) ?? 0) === 0) queue.push(child);
    }
  }
  // A deferrable FK cycle can leave a large tail. Sorting that tail in catalog
  // order loses immediate trigger dependencies even though their parent rows
  // must already exist when each BEFORE trigger runs. Re-sort the remainder
  // using only non-deferrable FKs and declared trigger parents; the remaining
  // cycles in this stricter graph are genuine and may safely stay at the end.
  const cyclicTail = names.filter((n) => !seen.has(n));
  const tailSet = new Set(cyclicTail);
  const immediateChildren = new Map(cyclicTail.map((n) => [n, new Set<string>()]));
  const addImmediateEdge = (parent: string, child: string) => {
    if (!tailSet.has(parent) || !tailSet.has(child) || parent === child) return;
    const siblings = immediateChildren.get(parent)!;
    if (!siblings.has(child)) {
      siblings.add(child);
    }
  };
  for (const t of cat.tables) {
    for (const ref of Object.values(t.hardFks)) addImmediateEdge(ref, t.name);
    for (const ref of TRIGGER_INSERT_TABLE_PARENTS[t.name] ?? []) addImmediateEdge(ref, t.name);
    for (const column of t.columns) {
      const ref = TRIGGER_INSERT_COLUMN_PARENTS[column.name];
      if (ref) addImmediateEdge(ref, t.name);
    }
  }
  // Collapse genuine immediate-dependency cycles so that acyclic dependants
  // of such a cycle still follow it. A plain Kahn pass followed by catalog
  // order would otherwise strand a trigger child beside its cyclic parents.
  let nextIndex = 0;
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const visit = (node: string) => {
    index.set(node, nextIndex);
    lowLink.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);
    for (const child of immediateChildren.get(node) ?? []) {
      if (!index.has(child)) {
        visit(child);
        lowLink.set(node, Math.min(lowLink.get(node)!, lowLink.get(child)!));
      } else if (onStack.has(child)) {
        lowLink.set(node, Math.min(lowLink.get(node)!, index.get(child)!));
      }
    }
    if (lowLink.get(node) === index.get(node)) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      components.push(component);
    }
  };
  for (const n of cyclicTail) if (!index.has(n)) visit(n);
  const componentFor = new Map<string, number>();
  components.forEach((members, component) => members.forEach((member) => componentFor.set(member, component)));
  const componentChildren = new Map(components.map((_, component) => [component, new Set<number>()]));
  const componentIndeg = new Map(components.map((_, component) => [component, 0]));
  for (const [parent, childrenForParent] of immediateChildren) {
    for (const child of childrenForParent) {
      const parentComponent = componentFor.get(parent)!;
      const childComponent = componentFor.get(child)!;
      if (parentComponent === childComponent || componentChildren.get(parentComponent)!.has(childComponent)) continue;
      componentChildren.get(parentComponent)!.add(childComponent);
      componentIndeg.set(childComponent, componentIndeg.get(childComponent)! + 1);
    }
  }
  const componentOrder = (component: number) => Math.min(...components[component]!.map((n) => names.indexOf(n)));
  const componentQueue = components.map((_, component) => component)
    .filter((component) => componentIndeg.get(component) === 0)
    .sort((a, b) => componentOrder(a) - componentOrder(b));
  while (componentQueue.length) {
    const component = componentQueue.shift()!;
    order.push(...components[component]!.sort((a, b) => names.indexOf(a) - names.indexOf(b)));
    for (const child of componentChildren.get(component) ?? []) {
      componentIndeg.set(child, componentIndeg.get(child)! - 1);
      if (componentIndeg.get(child) === 0) {
        componentQueue.push(child);
        componentQueue.sort((a, b) => componentOrder(a) - componentOrder(b));
      }
    }
  }
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
