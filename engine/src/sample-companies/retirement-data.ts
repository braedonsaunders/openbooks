import { sql, type SQL } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { PARENT_FILTER, type Catalog, type TableInfo } from "../sandbox/catalog.ts";
import { orderDependencyComponents } from "../sandbox/catalog-graph.ts";
import { retirementDigest } from "./retirement-contract.ts";

export const RETIREMENT_AUTH_TABLES = ["auth_login_challenges", "auth_login_events", "auth_login_state", "auth_mfa_factors", "auth_oidc_identities", "auth_password_resets", "auth_sessions"] as const;
export function retirementPredicate(table: Pick<TableInfo, "name" | "hasOrgId">, orgId: string): SQL {
  if (!isUuid(orgId)) throw new Error("Retirement predicates require an exact tenant UUID");
  if (table.name === "orgs") return sql`id=${orgId}::uuid`;
  if ((RETIREMENT_AUTH_TABLES as readonly string[]).includes(table.name)) return sql`user_id in (select id from public.users where org_id=${orgId}::uuid)`;
  if (table.hasOrgId) return sql`org_id=${orgId}::uuid`;
  if (PARENT_FILTER[table.name]) return sql.raw(PARENT_FILTER[table.name]!(orgId));
  throw new Error(`Tenant retirement has no ownership predicate for ${table.name}`);
}
export type RetirementFingerprint = { digest: string; tables: Array<{ table: string; count: string; digest: string }> };
/** Hash native row content, including drafts, audit, configuration and global auth children; never emit personal row values. */
export async function retirementFingerprint(catalog: Catalog, orgId: string): Promise<RetirementFingerprint> {
  const tables: RetirementFingerprint["tables"] = [];
  const owned = [...catalog.tenantTables.filter(t => t.name !== "orgs"), { name: "orgs", hasOrgId: false }, ...RETIREMENT_AUTH_TABLES.map(name => ({ name, hasOrgId: false }))];
  owned.sort((a, b) => a.name.localeCompare(b.name));
  if (new Set(owned.map(table => table.name)).size !== owned.length) throw new Error("Duplicate retirement fingerprint table identity");
  // Bound statement size and round trips without changing row content, tenant
  // ownership, empty-table evidence or the established digest ordering.
  const batchSize = 32;
  for (let offset = 0; offset < owned.length; offset += batchSize) {
    const batch = owned.slice(offset, offset + batchSize);
    const result = await db.execute<RetirementFingerprint["tables"][number]>(sql.join(batch.map(table => sql`
      select ${table.name}::text as "table",count(*)::text as count,
        encode(digest(coalesce(string_agg(row_hash,E'\n' order by row_hash),''),'sha256'),'hex') as digest
      from (select encode(digest(to_jsonb(owned_row)::text,'sha256'),'hex') as row_hash
        from public.${sql.identifier(table.name)} owned_row where ${retirementPredicate(table, orgId)}) owned_rows`), sql` union all `));
    const requested = new Set(batch.map(table => table.name));
    const received = new Map<string, RetirementFingerprint["tables"][number]>();
    for (const row of result.rows) {
      if (!requested.has(row.table)) throw new Error(`Unexpected retirement fingerprint table ${row.table}`);
      if (received.has(row.table)) throw new Error(`Duplicate retirement fingerprint for ${row.table}`);
      if (typeof row.count !== "string" || !/^(0|[1-9][0-9]*)$/.test(row.count)
        || typeof row.digest !== "string" || !/^[0-9a-f]{64}$/.test(row.digest)) {
        throw new Error(`Invalid retirement fingerprint for ${row.table}`);
      }
      received.set(row.table, row);
    }
    for (const table of batch) {
      const row = received.get(table.name);
      if (!row) throw new Error(`Missing retirement fingerprint for ${table.name}`);
      tables.push({ table: table.name, count: row.count, digest: row.digest });
    }
  }
  return { digest: retirementDigest(tables), tables };
}
function errorCode(error: unknown): string | undefined {
  const item = error as { code?: string; cause?: unknown } | null;
  return item?.code ?? (item?.cause ? errorCode(item.cause) : undefined);
}
export interface RetirementForeignKey {
  table: string; referencedTable: string; deleteAction: string; deferrable: boolean;
  columns: string[]; referencedColumns: string[];
}

/** Retirement cannot rely on cascades or SET NULL updates. Order every native
 * child before its parent; within deferred cycles retain all immediate actions.
 * Native row constraints still refuse cycles that need protected-row updates. */
export function retirementDeletionOrder(names: readonly string[], foreignKeys: readonly RetirementForeignKey[]): string[] {
  if (new Set(names).size !== names.length) throw new Error("Duplicate retirement table identity");
  const orderedNames = [...names].sort();
  const included = new Set(orderedNames);
  const dependencies = new Map(orderedNames.map(name => [name, new Set<string>()]));
  const indegree = new Map(orderedNames.map(name => [name, 0]));
  for (const edge of foreignKeys) {
    if (edge.table === edge.referencedTable || !included.has(edge.table) || !included.has(edge.referencedTable)) continue;
    if (dependencies.get(edge.table)!.has(edge.referencedTable)) continue;
    dependencies.get(edge.table)!.add(edge.referencedTable);
    indegree.set(edge.referencedTable, indegree.get(edge.referencedTable)! + 1);
  }
  const queue = orderedNames.filter(name => indegree.get(name) === 0);
  const order: string[] = [];
  while (queue.length) {
    const name = queue.shift()!;
    order.push(name);
    for (const parent of dependencies.get(name)!) {
      indegree.set(parent, indegree.get(parent)! - 1);
      if (indegree.get(parent) === 0) queue.push(parent);
    }
  }
  const emitted = new Set(order);
  const tail = orderedNames.filter(name => !emitted.has(name));
  const tailSet = new Set(tail);
  const immediate = new Map(tail.map(name => [name, new Set<string>()]));
  for (const edge of foreignKeys) {
    if (edge.table === edge.referencedTable || !tailSet.has(edge.table) || !tailSet.has(edge.referencedTable)) continue;
    // Referential actions execute immediately even on DEFERRABLE constraints.
    if (edge.deleteAction !== "a" || !edge.deferrable) immediate.get(edge.table)!.add(edge.referencedTable);
  }
  order.push(...orderDependencyComponents(tail, immediate));
  if (order.length !== names.length || new Set(order).size !== names.length) throw new Error("Incomplete retirement deletion order");
  return order;
}

/** Delete only owned rows. Constraint refusals are retried after their children;
 * cycles that cannot be removed without UPDATE roll back the entire target. */
export async function deleteRetiredTenantRows(catalog: Catalog, orgId: string) {
  const targets = catalog.tenantTables.filter(t => t.name !== "orgs");
  const byName = new Map(targets.map(table => [table.name, table]));
  const foreignKeys = (await db.execute<RetirementForeignKey & Record<string, unknown>>(sql`
    select c.relname as table,p.relname as "referencedTable",fk.confdeltype::text as "deleteAction",fk.condeferrable as deferrable,
      array_agg(child.attname::text order by position) as columns,array_agg(parent.attname::text order by position) as "referencedColumns"
    from pg_constraint fk join pg_class c on c.oid=fk.conrelid join pg_namespace n on n.oid=c.relnamespace
    join pg_class p on p.oid=fk.confrelid join pg_namespace pn on pn.oid=p.relnamespace
    cross join lateral generate_subscripts(fk.conkey,1) position
    join pg_attribute child on child.attrelid=fk.conrelid and child.attnum=fk.conkey[position]
    join pg_attribute parent on parent.attrelid=fk.confrelid and parent.attnum=fk.confkey[position]
    where n.nspname='public' and pn.nspname='public' and fk.contype='f'
    group by c.relname,p.relname,fk.oid,fk.confdeltype,fk.condeferrable order by c.relname,p.relname,fk.oid`)).rows;
  const order = retirementDeletionOrder(targets.map(table => table.name), foreignKeys);
  const selfEdges = foreignKeys.filter(edge => edge.table === edge.referencedTable && (edge.deleteAction !== "a" || !edge.deferrable));
  const removed: Record<string, string> = {};
  for (const name of RETIREMENT_AUTH_TABLES) {
    const result = await db.execute(sql`delete from public.${sql.identifier(name)} where ${retirementPredicate({ name, hasOrgId: false }, orgId)}`);
    if (result.rowCount == null) throw new Error(`Missing auth cleanup count for ${name}`);
    removed[name] = String(result.rowCount);
  }
  let pending = [...order];
  while (pending.length) {
    let progress = false;
    const refused: string[] = [];
    for (const name of pending) {
      const table = byName.get(name)!;
      const leaves = selfEdges.filter(edge => edge.table === name).map(edge => sql`not exists (
        select 1 from public.${sql.identifier(name)} child where ${sql.join(edge.columns.map((column, i) =>
          sql`child.${sql.identifier(column)}=owned_row.${sql.identifier(edge.referencedColumns[i]!)}`), sql` and `)})`);
      await db.execute(sql`savepoint retirement_table`);
      try {
        const result = await db.execute(sql`delete from public.${sql.identifier(name)} owned_row where ${retirementPredicate(table, orgId)}
          ${leaves.length ? sql`and ${sql.join(leaves, sql` and `)}` : sql``}`);
        if (result.rowCount == null) throw new Error(`Missing retirement affected-row count for ${name}`);
        const remaining = await db.execute(sql`select 1 from public.${sql.identifier(name)} where ${retirementPredicate(table, orgId)} limit 1`);
        await db.execute(sql`release savepoint retirement_table`);
        removed[name] = (BigInt(removed[name] ?? "0") + BigInt(result.rowCount)).toString();
        if (!remaining.rows.length) progress = true;
        else { refused.push(name); if (result.rowCount > 0) progress = true; }
      } catch (error) {
        await db.execute(sql`rollback to savepoint retirement_table`);
        await db.execute(sql`release savepoint retirement_table`);
        if (errorCode(error) !== "23503") throw error;
        refused.push(name);
      }
    }
    if (!progress) throw new Error(`Retirement cannot remove native foreign-key cycles without changing protected rows: ${refused.join(", ")}. Target transaction rolled back; preserve its quarantine and recovery evidence.`);
    pending = refused;
  }
  const result = await db.execute(sql`delete from public.orgs where id=${orgId}::uuid returning id`);
  if (result.rows.length !== 1) throw new Error("Retirement did not delete exactly its owned organization");
  removed.orgs = "1";
  // Deferred guards and FK constraints must succeed before the durable receipt.
  await db.execute(sql`set constraints all immediate`);
  return removed;
}

/** Foreign children outside the native ownership catalog require explicit
 * classification; orphaning an unknown global record is never a teardown step. */
export async function unclassifiedRetirementChildren(tenantTables: readonly string[]): Promise<string[]> {
  // Marketplace snapshots are shared publisher authority, never auth children.
  // Their target-specific dependency is checked separately before quarantine.
  const known = [...tenantTables, "orgs", "app_listings", ...RETIREMENT_AUTH_TABLES];
  const result = await db.execute<{ table: string }>(sql`
    select distinct child.relname as table from pg_class child join pg_namespace n on n.oid=child.relnamespace
    where n.nspname='public' and child.relkind in ('r','p') and not child.relname=any(${sql.param(known)}::text[])
      and (exists (select 1 from pg_constraint fk join pg_class parent on parent.oid=fk.confrelid
        where fk.contype='f' and fk.conrelid=child.oid and parent.relname=any(${sql.param(known)}::text[]))
      or exists (select 1 from pg_attribute a where a.attrelid=child.oid and not a.attisdropped
        and a.atttypid='uuid'::regtype and (a.attname='user_id' or a.attname like '%_user_id')))
    order by child.relname`);
  return result.rows.map(row => row.table);
}

/** Published and withdrawn marketplace snapshots retain their publisher.
 * Withdrawal preserves the shared row and therefore cannot authorize deletion. */
export async function retirementSharedDependencies(orgIds: readonly string[]) {
  return (await db.execute<{ table: string; orgId: string; count: string }>(sql`
    select 'app_listings' as table,publisher_org_id as "orgId",count(*)::text as count
    from public.app_listings where publisher_org_id=any(${sql.param([...orgIds])}::uuid[])
    group by publisher_org_id order by publisher_org_id`)).rows;
}

/** Queued or leased work must be resolved through its native lifecycle before
 * quarantine, so a mixed-tenant worker cannot repeatedly claim a fenced row. */
export async function retirementOutstandingWork(orgIds: readonly string[]) {
  const result = await db.execute<{ table: string; orgId: string; count: string }>(sql`
    select 'storage_cleanup_outbox' as table,org_id as "orgId",count(*)::text as count from storage_cleanup_outbox where org_id=any(${sql.param([...orgIds])}::uuid[]) group by org_id
    union all select 'scheduler_outbox',org_id,count(*)::text from scheduler_outbox where org_id=any(${sql.param([...orgIds])}::uuid[]) and (status in ('pending','running') or (status='failed' and terminal_failed_at is null)) group by org_id
    union all select 'report_delivery_outbox',org_id,count(*)::text from report_delivery_outbox where org_id=any(${sql.param([...orgIds])}::uuid[]) and (status in ('pending','enqueued','sending') or (status='failed' and terminal_failed_at is null)) group by org_id
    union all select 'posting_effects',org_id,count(*)::text from posting_effects where org_id=any(${sql.param([...orgIds])}::uuid[]) and status in ('pending','running','failed') group by org_id
    union all select 'report_runs',org_id,count(*)::text from report_runs where org_id=any(${sql.param([...orgIds])}::uuid[]) and (status in ('queued','running') or (status='failed' and terminal_failed_at is null)) group by org_id
    union all select 'email_log',org_id,count(*)::text from email_log where org_id=any(${sql.param([...orgIds])}::uuid[]) and status in ('queued','failed','uncertain') group by org_id
    union all select 'webhook_deliveries',org_id,count(*)::text from webhook_deliveries where org_id=any(${sql.param([...orgIds])}::uuid[]) and status not in ('delivered','dead') group by org_id
    union all select 'automation_runs',org_id,count(*)::text from automation_runs where org_id=any(${sql.param([...orgIds])}::uuid[]) and status in ('queued','running') group by org_id
    union all select 'data_transfer_jobs',org_id,count(*)::text from data_transfer_jobs where org_id=any(${sql.param([...orgIds])}::uuid[]) and state not in ('completed','failed','cancelled') group by org_id
    union all select 'payment_runs',org_id,count(*)::text from payment_runs where org_id=any(${sql.param([...orgIds])}::uuid[]) and status='processing' group by org_id
    union all select 'payment_files',org_id,count(*)::text from payment_files where org_id=any(${sql.param([...orgIds])}::uuid[]) and status in ('delivering','delivery_uncertain') group by org_id
    union all select 'sftp_import_schedules',org_id,count(*)::text from sftp_import_schedules where org_id=any(${sql.param([...orgIds])}::uuid[]) and run_claim_token is not null group by org_id
    order by 1,2`);
  return result.rows;
}
