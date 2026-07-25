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
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { sql } from "drizzle-orm";
import { db, longPool } from "./db.ts";
import { getS3Client, s3Bucket, s3Enabled } from "./file-storage.ts";
import { assertUuid, loadCatalog, PARENT_FILTER } from "./sandbox/catalog.ts";

/**
 * Organization backups.
 *
 * A backup is a gzip-compressed NDJSON stream of every row the org owns: the
 * org row, every tenant table (any base table with an org_id column — the same
 * self-maintaining catalog the sandbox clone engine uses), and org-less child
 * tables filtered through their parent. The export runs inside one REPEATABLE
 * READ, READ ONLY transaction so the dump is a single consistent point-in-time
 * snapshot, with the session timezone pinned to UTC so timestamptz values
 * render deterministically. Rows are embedded as raw row_to_json text — never
 * parsed in JS — so numerics and other precision-sensitive values round-trip
 * exactly.
 *
 * Format (one JSON object per line):
 *   line 1:  {"format":"openbooks-backup","version":1,"orgId":...,"createdAt":...}
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

/**
 * Stream the org's full dataset as NDJSON into `sink` (ending it). Bounded
 * memory: rows are pulled through a server-side cursor 2,000 at a time.
 */
export async function streamOrgBackup(orgId: string, sink: Writable): Promise<BackupExportStats> {
  assertUuid(orgId);
  const catalog = await loadCatalog();
  const tenantTables = catalog.tenantTables
    .filter((t) => t.hasOrgId)
    .map((t) => t.name)
    .sort();
  const childTables = Object.keys(PARENT_FILTER)
    .filter((n) => catalog.tenantTables.some((t) => t.name === n))
    .sort();
  const plan: { name: string; where: string }[] = [
    { name: "orgs", where: `t.id = '${orgId}'` },
    ...tenantTables.map((name) => ({ name, where: `t.org_id = '${orgId}'` })),
    ...childTables.map((name) => ({ name, where: PARENT_FILTER[name](orgId) })),
  ];
  for (const step of plan) {
    if (!TABLE_NAME_RE.test(step.name)) throw new Error(`unexpected table name: ${step.name}`);
  }

  const client = await longPool.connect();
  const stats: BackupExportStats = { tables: [], totalRows: 0 };
  const writeLine = async (line: string): Promise<void> => {
    if (sink.destroyed) throw new Error("backup output stream closed");
    if (!sink.write(line)) {
      await once(sink, "drain");
      if (sink.destroyed) throw new Error("backup output stream closed");
    }
  };

  try {
    // One consistent snapshot for the whole dump. SET TRANSACTION must come
    // before any other statement in the transaction.
    await client.query("begin isolation level repeatable read read only");
    await client.query(
      "select set_config('app.current_org', $1, true), set_config('app.bypass_rls', 'off', true)",
      [orgId],
    );
    await client.query("set local timezone to 'UTC'");

    await writeLine(
      JSON.stringify({
        format: "openbooks-backup",
        version: 1,
        orgId,
        createdAt: new Date().toISOString(),
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
  const claimed = (await db.execute(sql`
    update backup_runs
       set status = 'running', started_at = now(), updated_at = now()
     where id = ${runId} and status = 'queued'
     returning id, org_id, kind, actor_id`)) as unknown as {
    rows: { id: string; org_id: string; kind: string; actor_id: string | null }[];
    rowCount: number;
  };
  const run = claimed.rows[0];
  if (!run) return; // already claimed/finished — redelivery

  try {
    if (!s3Enabled) {
      throw new Error("S3 object storage is not configured (S3_ENDPOINT/S3_BUCKET/…)");
    }
    const orgRes = (await db.execute(sql`
      select name from orgs where id = ${run.org_id}`)) as unknown as {
      rows: { name: string }[];
    };
    const orgName = orgRes.rows[0]?.name ?? "org";
    const fileName = `${backupFileBaseName(orgName)}.json.gz`;
    const objectKey = backupObjectKey(run.org_id, run.id);

    const tmp = await mkdtemp(join(tmpdir(), "ob-backup-"));
    let stats: BackupExportStats;
    let byteSize: number;
    let sha256: string;
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

    await db.execute(sql`
      update backup_runs
         set status = 'completed', completed_at = now(), updated_at = now(),
             object_key = ${objectKey}, file_name = ${fileName},
             byte_size = ${byteSize!}, sha256 = ${sha256!},
             table_count = ${stats!.tables.length}, row_count = ${stats!.totalRows},
             error = null
       where id = ${run.id}`);
    await db.execute(sql`
      update backup_policies set last_run_at = now(), updated_at = now()
       where org_id = ${run.org_id}`);

    await auditBackupEvent({
      orgId: run.org_id,
      tableName: "backup_runs",
      rowId: run.id,
      actorId: run.actor_id,
      changes: {
        event: "backup_completed",
        kind: run.kind,
        fileName,
        byteSize: byteSize!,
        sha256: sha256!,
        rowCount: stats!.totalRows,
        tableCount: stats!.tables.length,
      },
    });

    await rotateBackups(run.org_id);
  } catch (err) {
    const message = ((err as Error).message || String(err)).slice(0, 2000);
    console.error(`[backup] run ${runId} failed:`, message);
    await db.execute(sql`
      update backup_runs
         set status = 'failed', error = ${message}, completed_at = now(), updated_at = now()
       where id = ${runId}`);
    await auditBackupEvent({
      orgId: run.org_id,
      tableName: "backup_runs",
      rowId: run.id,
      actorId: run.actor_id,
      changes: { event: "backup_failed", kind: run.kind, error: message },
    });
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
  const policy = (await db.execute(sql`
    select max_keep from backup_policies where org_id = ${orgId}`)) as unknown as {
    rows: { max_keep: number }[];
  };
  const maxKeep = policy.rows[0]?.max_keep ?? 7;

  const excess = (await db.execute(sql`
    select id, object_key, file_name, byte_size
      from backup_runs
     where org_id = ${orgId} and status = 'completed' and purged_at is null
     order by created_at desc
     offset ${maxKeep}`)) as unknown as {
    rows: { id: string; object_key: string | null; file_name: string | null; byte_size: number | null }[];
  };

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
