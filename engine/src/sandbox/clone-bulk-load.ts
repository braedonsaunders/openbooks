import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { assertUuid } from "./catalog.ts";

/**
 * Bulk loading for the sandbox clone.
 *
 * A clone copies rows that already passed every write guard when production
 * recorded them, and it copies them deterministically: each row is the same
 * values under rebased identifiers. Re-running every row trigger during the
 * copy proves nothing new and dominates the copy's cost, so when the clone's
 * database role may set `session_replication_role`, the copy runs with row
 * triggers and foreign-key triggers suspended for its own transaction only,
 * the way a restore or replication apply does. Integrity is then established
 * set-wise before the transaction can commit: every validated foreign key of
 * every copied table must resolve, and the ledger's own balance and currency
 * residual checks must pass over every copied entry. Any failure rolls the
 * whole copy back.
 *
 * `OPENBOOKS_SANDBOX_CLONE_BULK_LOAD=off` forces the row-by-row copy, which
 * admits each row through its write guards; it is also what runs where the
 * role holds no such privilege.
 */

/** Whether the operator permits bulk loading. Anything but on or off refuses. */
export function readCloneBulkLoadSetting(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.OPENBOOKS_SANDBOX_CLONE_BULK_LOAD?.trim();
  if (raw === undefined || raw === "" || raw === "on") return true;
  if (raw === "off") return false;
  throw new Error(
    `OPENBOOKS_SANDBOX_CLONE_BULK_LOAD must be "on" or "off"; received ${JSON.stringify(raw)}.`,
  );
}

/** True when this session's role may suspend triggers for its own transaction. */
export async function canSuspendTriggers(): Promise<boolean> {
  const rows = await db.execute<{ allowed: boolean }>(
    sql`
    select coalesce(
      (select rolsuper from pg_catalog.pg_roles where rolname = current_user), false)
      or (to_regprocedure('pg_catalog.has_parameter_privilege(text,text)') is not null
          and has_parameter_privilege('session_replication_role', 'SET')) as allowed`,
    "objects",
  );
  return rows[0]?.allowed === true;
}

export async function suspendTriggersForTransaction(): Promise<void> {
  await db.execute(sql`select set_config('session_replication_role', 'replica', true)`);
}

export async function resumeTriggersForTransaction(): Promise<void> {
  await db.execute(sql`select set_config('session_replication_role', 'origin', true)`);
}

/**
 * Rows that insert triggers maintain in tables the clone does not copy. With
 * triggers suspended the copy must write them itself, exactly as the trigger
 * would have for each copied parent row. A refresh that retained a parent row
 * already retains its catalog entry, so only missing entries are written.
 */
export async function writeTriggerMaintainedRows(sandboxOrgId: string): Promise<void> {
  const org = assertUuid(sandboxOrgId);
  await db.execute(sql`
    insert into hrm_benefit_catalog
      (id, org_id, insured_plan_id, employer_program_id, entitlement_plan_id,
       created_at, created_by, updated_at, updated_by)
    select parent.id, parent.org_id, parent.insured_plan_id, parent.employer_program_id,
           parent.entitlement_plan_id, parent.created_at, parent.created_by,
           parent.updated_at, parent.updated_by
      from (
        select id, org_id, id as insured_plan_id, null::uuid as employer_program_id,
               null::uuid as entitlement_plan_id, created_at, created_by, updated_at, updated_by
          from hrm_benefit_plans where org_id = ${org}
        union all
        select id, org_id, null, id, null, created_at, created_by, updated_at, updated_by
          from hrm_benefit_programs where org_id = ${org}
        union all
        select id, org_id, null, null, id, created_at, created_by, updated_at, updated_by
          from entitlement_plans where org_id = ${org}
      ) parent
     where not exists (select 1 from hrm_benefit_catalog existing where existing.id = parent.id)`);
}

export interface BulkLoadedTable {
  name: string;
  hasOrgId: boolean;
}

interface ForeignKey {
  constraint: string;
  child: string;
  parentSchema: string;
  parent: string;
  childColumns: string[];
  parentColumns: string[];
}

const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/**
 * Prove a bulk-loaded copy is complete before it commits: every validated
 * foreign key of every copied table resolves inside the database, and every
 * copied journal entry passes the ledger's balance and currency-residual
 * checks. `parentFilter` scopes the few copied tables that carry no org_id.
 */
export async function verifyBulkLoadedClone(args: {
  sandboxOrgId: string;
  tables: readonly BulkLoadedTable[];
  parentFilter: Readonly<Record<string, (orgId: string) => string>>;
}): Promise<void> {
  const org = assertUuid(args.sandboxOrgId);
  const byName = new Map(args.tables.map((t) => [t.name, t]));
  if (byName.size === 0) return;
  const keys = await db.execute<ForeignKey>(
    sql`
    select con.conname as "constraint", child.relname as child, parent_ns.nspname as "parentSchema",
           parent.relname as parent,
           array_agg(child_column.attname::text order by key.position) as "childColumns",
           array_agg(parent_column.attname::text order by key.position) as "parentColumns"
      from pg_catalog.pg_constraint con
      join pg_catalog.pg_class child on child.oid = con.conrelid
      join pg_catalog.pg_namespace child_ns on child_ns.oid = child.relnamespace and child_ns.nspname = 'public'
      join pg_catalog.pg_class parent on parent.oid = con.confrelid
      join pg_catalog.pg_namespace parent_ns on parent_ns.oid = parent.relnamespace
      cross join lateral unnest(con.conkey, con.confkey) with ordinality as key(child_attnum, parent_attnum, position)
      join pg_catalog.pg_attribute child_column
        on child_column.attrelid = con.conrelid and child_column.attnum = key.child_attnum
      join pg_catalog.pg_attribute parent_column
        on parent_column.attrelid = con.confrelid and parent_column.attnum = key.parent_attnum
     where con.contype = 'f' and con.convalidated
       and child.relname = any(string_to_array(${[...byName.keys()].join(",")}, ','))
     group by con.oid, con.conname, child.relname, parent_ns.nspname, parent.relname
     order by child.relname, con.conname`,
    "objects",
  );
  const unresolved: string[] = [];
  for (const key of keys) {
    const table = byName.get(key.child)!;
    const scope = table.hasOrgId
      ? `child.org_id = '${org}'`
      : args.parentFilter[table.name]
        ? `(${args.parentFilter[table.name]!(org)})`
        : null;
    if (scope === null) continue;
    const present = key.childColumns.map((c) => `child.${ident(c)} is not null`).join(" and ");
    const match = key.childColumns
      .map((c, i) => `parent.${ident(key.parentColumns[i]!)} = child.${ident(c)}`)
      .join(" and ");
    const rows = await db.execute<{ broken: boolean }>(
      sql.raw(`select exists (
        select 1 from public.${ident(key.child)} child
         where ${scope} and ${present}
           and not exists (select 1 from ${ident(key.parentSchema)}.${ident(key.parent)} parent where ${match})
      ) as broken`),
      "objects",
    );
    if (rows[0]?.broken) unresolved.push(`${key.child}.${key.constraint}`);
  }
  if (unresolved.length > 0) {
    throw new Error(
      `The sandbox copy left references unresolved (${unresolved.slice(0, 10).join(", ")}${
        unresolved.length > 10 ? `, and ${unresolved.length - 10} more` : ""
      }); the copy was rolled back. Retry the sandbox after the source data is corrected.`,
    );
  }
  if (byName.has("journal_lines")) {
    await db.execute(sql`
      select public.journal_lines_check_balanced_entries(
        array(select distinct entry_id from journal_lines where org_id = ${org}))`);
    await db.execute(sql`
      select public.journal_lines_check_fx_residual_entries(
        array(select distinct entry_id from journal_lines where org_id = ${org}), true)`);
  }
}
