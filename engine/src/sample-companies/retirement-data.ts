import { sql, type SQL } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { PARENT_FILTER, deletionOrder, type Catalog, type TableInfo } from "../sandbox/catalog.ts";
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
  for (const table of owned.sort((a, b) => a.name.localeCompare(b.name))) {
    const result = await db.execute<{ count: string; digest: string }>(sql`
      select count(*)::text as count,encode(digest(coalesce(string_agg(row_hash,E'\n' order by row_hash),''),'sha256'),'hex') as digest
      from (select encode(digest(to_jsonb(owned_row)::text,'sha256'),'hex') as row_hash
        from public.${sql.identifier(table.name)} owned_row where ${retirementPredicate(table, orgId)}) owned_rows`);
    if (!result.rows[0]) throw new Error(`Missing retirement fingerprint for ${table.name}`);
    tables.push({ table: table.name, ...result.rows[0] });
  }
  return { digest: retirementDigest(tables), tables };
}
function errorCode(error: unknown): string | undefined {
  const item = error as { code?: string; cause?: unknown } | null;
  return item?.code ?? (item?.cause ? errorCode(item.cause) : undefined);
}
/** Delete only owned rows. Constraint refusals are retried after their children;
 * cycles that cannot be removed without UPDATE roll back the entire target. */
export async function deleteRetiredTenantRows(catalog: Catalog, orgId: string) {
  const targets = catalog.tenantTables.filter(t => t.name !== "orgs");
  const byName = new Map(targets.map(table => [table.name, table]));
  const order = deletionOrder({ ...catalog, tables: targets });
  const selfEdges = (await db.execute<{ table: string; columns: string[]; referencedColumns: string[] }>(sql`
    select c.relname as table,array_agg(child.attname order by position) as columns,array_agg(parent.attname order by position) as "referencedColumns"
    from pg_constraint fk join pg_class c on c.oid=fk.conrelid join pg_namespace n on n.oid=c.relnamespace
    cross join lateral generate_subscripts(fk.conkey,1) position
    join pg_attribute child on child.attrelid=fk.conrelid and child.attnum=fk.conkey[position]
    join pg_attribute parent on parent.attrelid=fk.confrelid and parent.attnum=fk.confkey[position]
    where n.nspname='public' and fk.contype='f' and fk.confrelid=fk.conrelid and (fk.confdeltype<>'a' or not fk.condeferrable)
    group by c.relname,fk.oid order by c.relname,fk.oid`)).rows;
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
  const known = [...tenantTables, "orgs", ...RETIREMENT_AUTH_TABLES];
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
