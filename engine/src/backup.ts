import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { sql } from "drizzle-orm";
import { db, longPool, withBypassContext, withOrgContext } from "./db.ts";
import { getS3Client, s3Bucket, s3Enabled } from "./file-storage.ts";
import { assertUuid, loadCatalog, PARENT_FILTER } from "./sandbox/catalog.ts";
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BACKUP_DATA_KEY_CHECK_PLAINTEXT,
  DURABLE_USER_AUTH_BACKUP_TABLES,
  ORGLESS_CHILD_BACKUP_TABLES,
  ORG_SCOPED_BACKUP_EXCLUSIONS,
  backupSchemaFingerprint,
  type BackupQueryable,
} from "./backup-format.ts";
import { sealSecret } from "./secrets.ts";

/**
 * Organization backups.
 *
 * A backup is a gzip-compressed NDJSON stream of every row the org owns: the
 * org row, tenant tables (any base table with an org_id column, except the
 * explicitly non-portable cross-tenant access-grant table), org-less children,
 * and durable MFA/OIDC rows filtered through their home user. Live sessions,
 * login challenges/state/events are intentionally excluded. The export runs
 * inside one REPEATABLE
 * READ, READ ONLY transaction so the dump is a single consistent point-in-time
 * snapshot, with the session timezone pinned to UTC so timestamptz values
 * render deterministically. Rows are embedded as raw row_to_json text — never
 * parsed in JS — so numerics and other precision-sensitive values round-trip
 * exactly.
 *
 * Format (one JSON object per line):
 *   line 1:  {"format":"openbooks-backup","version":3,"orgId":...,"createdAt":...,"schemaSha256":...,"dataKeyCheck":...}
 *   rows:    {"t":"<table>","r":{...row...}}
 *   last:    {"meta":{"tables":[{name,rows}...],"totalRows":N,"completedAt":...}}
 *
 * Stored backups live in the app's S3 bucket at backups/{orgId}/{runId}.json.gz
 * with a backup_runs ledger row (size, sha256, status, disposition). Rotation
 * keeps the newest policy.maxKeep completed backups and purges the rest —
 * purging removes the object but never the ledger row.
 */

export interface BackupPolicyShape {
  frequency: "daily" | "weekly" | "monthly";
  hourUtc: number;
  dayOfWeek: number; // 0=Sunday … 6=Saturday (weekly)
  dayOfMonth: number; // 1–28 (monthly)
}

export interface BackupExportStats {
  tables: { name: string; rows: number }[];
  totalRows: number;
}

/** Next fire time (UTC) for a policy, strictly after `from`. */
export function computeNextRunAt(p: BackupPolicyShape, from = new Date()): Date {
  const at = (day: number) =>
    new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), day, p.hourUtc, 0, 0, 0));

  if (p.frequency === "daily") {
    const c = at(from.getUTCDate());
    if (c.getTime() <= from.getTime()) c.setUTCDate(c.getUTCDate() + 1);
    return c;
  }
  if (p.frequency === "weekly") {
    const c = at(from.getUTCDate());
    c.setUTCDate(c.getUTCDate() + ((p.dayOfWeek - from.getUTCDay() + 7) % 7));
    if (c.getTime() <= from.getTime()) c.setUTCDate(c.getUTCDate() + 7);
    return c;
  }
  // monthly — day_of_month is constrained to 1–28 so every month has it.
  const c = at(p.dayOfMonth);
  if (c.getTime() <= from.getTime()) c.setUTCMonth(c.getUTCMonth() + 1);
  return c;
}

/** `{org-slug}-backup-20260724-101500` — safe, sortable download file base name. */
export function backupFileBaseName(orgName: string, at = new Date()): string {
  const slug =
    orgName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "org";
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  return `${slug}-backup-${stamp}`;
}

export function backupObjectKey(orgId: string, runId: string): string {
  return `backups/${assertUuid(orgId)}/${assertUuid(runId)}.json.gz`;
}

const TABLE_NAME_RE = /^[a-z0-9_]+$/;

interface BackupPlanStep {
  name: string;
  where: string;
}

function whereForAlias(where: string, alias: string): string {
  return where.replace(/\bt\./g, `${alias}.`);
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Prove that every FK from an included row to another archived table resolves
 * to a row inside this same archive. This catches cross-organization links such
 * as orgs.sandbox_of and change_sets.sandbox_org_id before any apparently valid
 * backup is emitted. References to shared/bootstrap tables (for example the ISO
 * currency registry) are outside the tenant archive and are instead protected
 * by the exact migration/schema preflight during restore.
 */
async function assertForeignKeyClosure(
  client: BackupQueryable,
  plan: readonly BackupPlanStep[],
): Promise<void> {
  const byTable = new Map(plan.map((step) => [step.name, step]));
  const constraints = await client.query<{
    constraint_name: string;
    source_table: string;
    target_table: string;
    source_columns: string[];
    target_columns: string[];
  }>(
    `select constraint_row.conname as constraint_name,
            source.relname as source_table,
            target.relname as target_table,
            array_agg(source_column.attname::text order by key_row.position) as source_columns,
            array_agg(target_column.attname::text order by key_row.position) as target_columns
       from pg_constraint constraint_row
       join pg_class source on source.oid = constraint_row.conrelid
       join pg_class target on target.oid = constraint_row.confrelid
       join pg_namespace source_namespace on source_namespace.oid = source.relnamespace
       join pg_namespace target_namespace on target_namespace.oid = target.relnamespace
       cross join lateral unnest(constraint_row.conkey, constraint_row.confkey)
         with ordinality as key_row(source_attnum, target_attnum, position)
       join pg_attribute source_column
         on source_column.attrelid = source.oid and source_column.attnum = key_row.source_attnum
       join pg_attribute target_column
         on target_column.attrelid = target.oid and target_column.attnum = key_row.target_attnum
      where constraint_row.contype = 'f'
        and source_namespace.nspname = 'public'
        and target_namespace.nspname = 'public'
        and source.relname = any($1::text[])
        and target.relname = any($1::text[])
      group by constraint_row.oid, constraint_row.conname, source.relname, target.relname
      order by source.relname, constraint_row.conname`,
    [plan.map((step) => step.name)],
  );

  const checks: string[] = [];
  for (const constraint of constraints.rows) {
    const source = byTable.get(constraint.source_table);
    const target = byTable.get(constraint.target_table);
    if (!source || !target || constraint.source_columns.length !== constraint.target_columns.length) {
      throw new Error(`backup FK catalog is inconsistent at ${constraint.constraint_name}`);
    }
    for (const identifier of [
      constraint.source_table,
      constraint.target_table,
      ...constraint.source_columns,
      ...constraint.target_columns,
    ]) {
      if (!TABLE_NAME_RE.test(identifier)) throw new Error("unexpected identifier in backup FK catalog");
    }
    const populated = constraint.source_columns
      .map((column) => `t."${column}" is not null`)
      .join(" and ");
    const reference = constraint.source_columns
      .map((column, index) => `target_row."${constraint.target_columns[index]}" = t."${column}"`)
      .join(" and ");
    checks.push(
      `select ${sqlLiteral(constraint.source_table)} as source_table,
              ${sqlLiteral(constraint.constraint_name)} as constraint_name,
              ${sqlLiteral(constraint.target_table)} as target_table
         where exists (
           select 1 from public."${constraint.source_table}" t
            where (${source.where}) and (${populated})
              and not exists (
                select 1 from public."${constraint.target_table}" target_row
                 where (${reference}) and (${whereForAlias(target.where, "target_row")})
              )
         )`,
    );
  }

  // Bound individual statement size while avoiding hundreds of network round
  // trips on schemas with a large FK graph.
  for (let offset = 0; offset < checks.length; offset += 25) {
    const violation = await client.query(checks.slice(offset, offset + 25).join("\nunion all\n") + "\nlimit 1");
    const row = violation.rows[0] as
      | { source_table: string; constraint_name: string; target_table: string }
      | undefined;
    if (row) {
      throw new Error(
        `organization backup is not self-contained: ${row.source_table}.${row.constraint_name} references ${row.target_table} outside the organization; use full-deployment recovery or remove/reconcile the external relationship first`,
      );
    }
  }
}

/**
 * Stream the org's full dataset as NDJSON into `sink` (ending it). Bounded
 * memory: rows are pulled through a server-side cursor 2,000 at a time.
 */
export async function streamOrgBackup(orgId: string, sink: Writable): Promise<BackupExportStats> {
  assertUuid(orgId);
  const client = await longPool.connect();
  let deploymentLock = false;
  const stats: BackupExportStats = { tables: [], totalRows: 0 };
  const writeLine = async (line: string): Promise<void> => {
    if (sink.destroyed) throw new Error("backup output stream closed");
    if (!sink.write(line)) {
      await once(sink, "drain");
      if (sink.destroyed) throw new Error("backup output stream closed");
    }
  };

  try {
    // Prevent a migration from changing the table catalog between the schema
    // fingerprint and row export. Bootstrap takes the exclusive counterpart.
    await client.query("select pg_advisory_lock_shared(hashtextextended($1, 0))", [
      "openbooks:deployment-bootstrap",
    ]);
    deploymentLock = true;
    // One consistent snapshot for the whole dump. SET TRANSACTION must come
    // before any other statement in the transaction.
    await client.query("begin isolation level repeatable read read only");
    await client.query(
      "select set_config('app.current_org', $1, true), set_config('app.bypass_rls', 'off', true)",
      [orgId],
    );
    await client.query("set local timezone to 'UTC'");

    const catalog = await loadCatalog();
    const excludedOrgTables = new Set<string>(ORG_SCOPED_BACKUP_EXCLUSIONS);
    const tenantTables = catalog.tenantTables
      .filter((t) => t.hasOrgId)
      .map((t) => t.name)
      .filter((name) => !excludedOrgTables.has(name))
      .sort();
    const childTables = ORGLESS_CHILD_BACKUP_TABLES
      .filter((name) => catalog.tenantTables.some((table) => table.name === name))
      .sort();
    for (const name of childTables) {
      if (!PARENT_FILTER[name]) throw new Error(`backup child table ${name} has no ownership filter`);
    }
    const presentAuthTables = await client.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
          and table_name = any($1::text[])
        order by table_name`,
      [[...DURABLE_USER_AUTH_BACKUP_TABLES]],
    );
    const plan: BackupPlanStep[] = [
      { name: "orgs", where: `t.id = '${orgId}'` },
      ...tenantTables.map((name) => ({ name, where: `t.org_id = '${orgId}'` })),
      ...childTables.map((name) => ({ name, where: PARENT_FILTER[name](orgId) })),
      ...presentAuthTables.rows.map(({ table_name: name }) => ({
        name,
        where:
          `t.user_id in (select id from public.users where org_id = '${orgId}')` +
          (name === "auth_mfa_factors" ? " and t.enabled_at is not null" : ""),
      })),
    ];
    for (const step of plan) {
      if (!TABLE_NAME_RE.test(step.name)) throw new Error(`unexpected table name: ${step.name}`);
    }

    await assertForeignKeyClosure(client, plan);
    const schemaSha256 = await backupSchemaFingerprint(
      client,
      plan.map((step) => step.name),
    );

    await writeLine(
      JSON.stringify({
        format: BACKUP_FORMAT,
        version: BACKUP_FORMAT_VERSION,
        orgId,
        createdAt: new Date().toISOString(),
        schemaSha256,
        dataKeyCheck: sealSecret(BACKUP_DATA_KEY_CHECK_PLAINTEXT),
      }) + "\n",
    );

    for (const { name, where } of plan) {
      await client.query(
        `declare ob_backup_cur no scroll cursor for select row_to_json(t)::text as r from "public"."${name}" t where ${where}`,
      );
      let rows = 0;
      try {
        for (;;) {
          const res = await client.query("fetch 2000 from ob_backup_cur");
          if (res.rows.length === 0) break;
          for (const row of res.rows) {
            await writeLine(`{"t":${JSON.stringify(name)},"r":${row.r}}\n`);
          }
          rows += res.rows.length;
        }
      } finally {
        await client.query("close ob_backup_cur").catch(() => {});
      }
      stats.tables.push({ name, rows });
      stats.totalRows += rows;
    }

    await writeLine(
      JSON.stringify({
        meta: { tables: stats.tables, totalRows: stats.totalRows, completedAt: new Date().toISOString() },
      }) + "\n",
    );
    sink.end();
    await client.query("commit");
    return stats;
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      // connection already broken
    }
    sink.destroy(err as Error);
    throw err;
  } finally {
    if (deploymentLock) {
      await client
        .query("select pg_advisory_unlock_shared(hashtextextended($1, 0))", [
          "openbooks:deployment-bootstrap",
        ])
        .catch(() => {});
    }
    client.release();
  }
}

export async function putBackupObject(args: {
  key: string;
  body: Readable;
  byteLength: number;
  fileName: string;
  sha256: string;
}): Promise<void> {
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: s3Bucket(),
      Key: args.key,
      Body: args.body,
      ContentLength: args.byteLength,
      ContentType: "application/gzip",
      ContentDisposition: `attachment; filename="${args.fileName}"`,
      Metadata: { sha256: args.sha256 },
    }),
  );
}

export async function getBackupObject(key: string) {
  return getS3Client().send(new GetObjectCommand({ Bucket: s3Bucket(), Key: key }));
}

export async function headBackupObject(key: string) {
  return getS3Client().send(new HeadObjectCommand({ Bucket: s3Bucket(), Key: key }));
}

export async function deleteBackupObject(key: string): Promise<void> {
  await getS3Client().send(new DeleteObjectCommand({ Bucket: s3Bucket(), Key: key }));
}

/**
 * Backup-lifecycle evidence in audit_log. The action enum has no backup verbs,
 * so the specific event rides in changes.event (the file-audit convention).
 * Best-effort: a logging failure must never fail the user action.
 */
export async function auditBackupEvent(args: {
  orgId: string;
  tableName: "backup_runs" | "backup_policies" | "orgs";
  rowId: string;
  actorId: string | null;
  changes: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${args.orgId}, ${args.tableName}, ${args.rowId}, 'update',
              ${JSON.stringify(args.changes)}, ${args.actorId})`);
  } catch (err) {
    console.error("[backup] audit write failed:", (err as Error).message);
  }
}

/**
 * Execute one queued backup_runs row (BullMQ worker entry). Idempotent: only a
 * row still 'queued' is claimed, so a redelivered job no-ops. The export spools
 * to a temp file first so the object is uploaded with an exact Content-Length
 * and a sha256 computed over the bytes that were actually written.
 */
export async function executeBackupRun(runId: string): Promise<void> {
  assertUuid(runId);
  // A queued run names its tenant, but this worker cannot know it until the row
  // is claimed — so the claim is the ONE statement that crosses a trusted
  // boundary. Everything after it runs inside that tenant's own RLS scope.
  const claimed = await withBypassContext(() =>
    db.execute<{ id: string; org_id: string; kind: string; actor_id: string | null }>(sql`
    update backup_runs
       set status = 'running', started_at = now(), updated_at = now()
     where id = ${runId} and status = 'queued'
     returning id, org_id, kind, actor_id`));
  const run = claimed.rows[0];
  if (!run) return; // already claimed/finished — redelivery

  // A large organization can legitimately need longer than the scheduler's
  // stale-run horizon. Keep the ledger lease fresh throughout export, hashing,
  // upload, and finalization so reconciliation never races healthy work.
  let heartbeatBusy = false;
  const heartbeatTimer = setInterval(() => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    // The timer was armed before the tenant scope below was entered, so this
    // callback carries no context of its own and must re-enter it explicitly.
    void withOrgContext(run.org_id, () => db.execute(sql`
      update backup_runs set updated_at = now()
       where id = ${run.id} and status = 'running'
    `)).catch((error) => {
      console.error(`[backup] run ${run.id}: heartbeat failed:`, (error as Error).message);
    }).finally(() => {
      heartbeatBusy = false;
    });
  }, 60_000);
  heartbeatTimer.unref?.();

  try {
  await withOrgContext(run.org_id, async () => {
  let objectKey: string | null = null;
  let fileName: string | null = null;
  let stats: BackupExportStats | null = null;
  let byteSize: number | null = null;
  let sha256: string | null = null;
  let uploadAttempted = false;
  let completed = false;
  try {
    if (!s3Enabled) {
      throw new Error("S3 object storage is not configured (S3_ENDPOINT/S3_BUCKET/…)");
    }
    const orgRes = (await db.execute<{ name: string }>(sql`
      select name from orgs where id = ${run.org_id}`));
    const orgName = orgRes.rows[0]?.name ?? "org";
    fileName = `${backupFileBaseName(orgName)}.json.gz`;
    objectKey = backupObjectKey(run.org_id, run.id);

    const tmp = await mkdtemp(join(tmpdir(), "ob-backup-"));
    try {
      const tmpFile = join(tmp, "backup.ndjson.gz");
      const hash = createHash("sha256");
      const gzip = createGzip({ level: 6 });
      const hasher = new Transform({
        transform(chunk, _enc, cb) {
          hash.update(chunk);
          cb(null, chunk);
        },
      });
      const pipeDone = pipeline(gzip, hasher, createWriteStream(tmpFile));
      stats = await streamOrgBackup(run.org_id, gzip);
      await pipeDone;
      byteSize = (await stat(tmpFile)).size;
      sha256 = hash.digest("hex");

      // Persist a deterministic upload intent before touching S3. A worker
      // crash can then reconcile this exact key/hash instead of leaking an
      // anonymous object or re-exporting a different snapshot.
      const intended = (await db.execute<{ id: string }>(sql`
        update backup_runs
           set object_key = ${objectKey}, file_name = ${fileName},
               byte_size = ${byteSize}, sha256 = ${sha256},
               table_count = ${stats.tables.length}, row_count = ${stats.totalRows},
               updated_at = now()
         where id = ${run.id} and status = 'running'
         returning id`));
      if (!intended.rows[0]) throw new Error("backup run lost its running claim before upload");

      uploadAttempted = true;
      await putBackupObject({
        key: objectKey,
        body: createReadStream(tmpFile),
        byteLength: byteSize,
        fileName,
        sha256,
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }

    const finalized = (await db.execute<{ id: string }>(sql`
      update backup_runs
         set status = 'completed', completed_at = now(), updated_at = now(),
             error = null
       where id = ${run.id} and status = 'running'
       returning id`));
    if (!finalized.rows[0]) throw new Error("backup run could not be finalized from running state");
    completed = true;
  } catch (err) {
    const message = ((err as Error).message || String(err)).slice(0, 2000);
    console.error(`[backup] run ${runId} failed:`, message);
    // A finalization response can be lost after PostgreSQL committed. Re-read
    // state before deleting anything so an ambiguous network error cannot turn
    // a completed ledger row into a missing object.
    let state: { status: string } | undefined;
    try {
      const stateResult = (await db.execute<{ status: string }>(sql`
        select status from backup_runs where id = ${runId}`));
      state = stateResult.rows[0];
    } catch (stateError) {
      console.error(
        `[backup] run ${runId}: database state unavailable; leaving upload intent for scheduler reconciliation:`,
        (stateError as Error).message,
      );
      return;
    }
    if (state?.status === "completed") {
      completed = true;
    } else if (state?.status === "running") {
      let cleaned = !uploadAttempted || !objectKey;
      if (!cleaned && objectKey) {
        try {
          await deleteBackupObject(objectKey);
          cleaned = true;
        } catch (cleanupError) {
          console.error(
            `[backup] run ${runId}: upload cleanup failed; scheduler will reconcile ${objectKey}:`,
            (cleanupError as Error).message,
          );
        }
      }
      if (cleaned) {
        await db.execute(sql`
          update backup_runs
             set status = 'failed', object_key = null, error = ${message},
                 completed_at = now(), updated_at = now()
           where id = ${runId} and status = 'running'`);
        await auditBackupEvent({
          orgId: run.org_id,
          tableName: "backup_runs",
          rowId: run.id,
          actorId: run.actor_id,
          changes: { event: "backup_failed", kind: run.kind, error: message },
        });
      } else {
        await db.execute(sql`
          update backup_runs
             set error = ${`upload/finalization uncertain; awaiting reconciliation: ${message}`}, updated_at = now()
           where id = ${runId} and status = 'running'`);
      }
    }
  }

  if (!completed || !stats || !fileName || byteSize === null || !sha256) return;

  await auditBackupEvent({
    orgId: run.org_id,
    tableName: "backup_runs",
    rowId: run.id,
    actorId: run.actor_id,
    changes: {
      event: "backup_completed",
      kind: run.kind,
      fileName,
      byteSize,
      sha256,
      rowCount: stats.totalRows,
      tableCount: stats.tables.length,
    },
  });
  try {
    await db.execute(sql`
      update backup_policies set last_run_at = now(), updated_at = now()
       where org_id = ${run.org_id}`);
  } catch (error) {
    console.error(`[backup] run ${runId}: policy timestamp update failed after completion:`, (error as Error).message);
  }
  try {
    await rotateBackups(run.org_id);
  } catch (error) {
    // Retention is post-completion maintenance. It must never relabel or hide a
    // verified backup; the next run (or an operator) can retry rotation.
    console.error(`[backup] run ${runId}: retention failed after completion (will retry):`, (error as Error).message);
    await auditBackupEvent({
      orgId: run.org_id,
      tableName: "backup_runs",
      rowId: run.id,
      actorId: run.actor_id,
      changes: { event: "backup_retention_failed", kind: run.kind, error: (error as Error).message.slice(0, 2000) },
    });
  }
  });
  } finally {
    clearInterval(heartbeatTimer);
  }
}

/**
 * Retention: keep the newest policy.maxKeep completed backups; purge the rest.
 * Purging deletes the S3 object and stamps the ledger row (purged_at +
 * purge_reason='rotated') — the row is never hard-deleted. An S3 delete
 * failure leaves the row live so the next rotation retries it.
 */
export async function rotateBackups(orgId: string): Promise<void> {
  assertUuid(orgId);
  const policy = (await db.execute<{ max_keep: number }>(sql`
    select max_keep from backup_policies where org_id = ${orgId}`));
  const maxKeep = policy.rows[0]?.max_keep ?? 7;

  const excess = (await db.execute<{ id: string; object_key: string | null; file_name: string | null; byte_size: number | null }>(sql`
    select id, object_key, file_name, byte_size
      from backup_runs
     where org_id = ${orgId} and status = 'completed' and purged_at is null
     order by created_at desc
     offset ${maxKeep}`));

  for (const run of excess.rows) {
    if (run.object_key) {
      try {
        await deleteBackupObject(run.object_key);
      } catch (err) {
        console.error(`[backup] rotation: S3 delete failed for ${run.object_key} (will retry next run):`, (err as Error).message);
        continue;
      }
    }
    await db.execute(sql`
      update backup_runs
         set purged_at = now(), purge_reason = 'rotated', updated_at = now()
       where id = ${run.id}`);
    await auditBackupEvent({
      orgId,
      tableName: "backup_runs",
      rowId: run.id,
      actorId: null,
      changes: {
        event: "backup_rotated",
        fileName: run.file_name,
        byteSize: run.byte_size,
        maxKeep,
      },
    });
  }
  if (excess.rows.length > 0) {
    console.log(`[backup] org ${orgId}: rotated out ${excess.rows.length} backup(s) beyond keep=${maxKeep}`);
  }
}
