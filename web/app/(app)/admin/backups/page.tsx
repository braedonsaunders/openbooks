import { sql } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@openbooks/ui";
import { db } from "@openbooks/engine/src/db.ts";
import { s3Enabled } from "@openbooks/engine/src/file-storage.ts";
import { getWorkerHeartbeat } from "@openbooks/jobs";
import { ListPageLayout } from "../../../../components/page-layout";
import { requirePermission } from "../../../../lib/authz";
import { BackupManager, type BackupPolicyRow, type BackupRunRow } from "./BackupManager";

export const dynamic = "force-dynamic";

function isoTimestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid backup timestamp: ${String(value)}`);
  }
  return date.toISOString();
}

export default async function BackupsPage() {
  const authz = await requirePermission("admin.backups.manage");
  const tHub = await getTranslations("admin.hub");
  const { orgId } = authz.user;

  const policyRes = (await db.execute(sql`
    select enabled, frequency, hour_utc, day_of_week, day_of_month, max_keep,
           last_run_at, next_run_at
      from backup_policies where org_id = ${orgId}`)) as unknown as {
    rows: {
      enabled: boolean;
      frequency: string;
      hour_utc: number;
      day_of_week: number;
      day_of_month: number;
      max_keep: number;
      last_run_at: Date | string | null;
      next_run_at: Date | string | null;
    }[];
  };
  const p = policyRes.rows[0];
  const policy: BackupPolicyRow | null = p
    ? {
        enabled: p.enabled,
        frequency: p.frequency as BackupPolicyRow["frequency"],
        hourUtc: p.hour_utc,
        dayOfWeek: p.day_of_week,
        dayOfMonth: p.day_of_month,
        maxKeep: p.max_keep,
        lastRunAt: isoTimestamp(p.last_run_at),
        nextRunAt: isoTimestamp(p.next_run_at),
      }
    : null;

  const runsRes = (await db.execute(sql`
    select id, kind, status, file_name, byte_size, table_count, row_count, sha256,
           error, purged_at, purge_reason, created_at, completed_at
      from backup_runs
     where org_id = ${orgId}
     order by created_at desc
     limit 50`)) as unknown as {
    rows: {
      id: string;
      kind: string;
      status: string;
      file_name: string | null;
      byte_size: number | null;
      table_count: number | null;
      row_count: number | null;
      sha256: string | null;
      error: string | null;
      purged_at: Date | string | null;
      purge_reason: string | null;
      created_at: Date | string;
      completed_at: Date | string | null;
    }[];
  };
  const runs: BackupRunRow[] = runsRes.rows.map((r) => ({
    id: r.id,
    kind: r.kind as BackupRunRow["kind"],
    status: r.status as BackupRunRow["status"],
    fileName: r.file_name,
    // bigint/numeric columns arrive from the pg driver as strings.
    byteSize: r.byte_size === null ? null : Number(r.byte_size),
    tableCount: r.table_count === null ? null : Number(r.table_count),
    rowCount: r.row_count === null ? null : Number(r.row_count),
    sha256: r.sha256,
    error: r.error,
    purgedAt: isoTimestamp(r.purged_at),
    purgeReason: r.purge_reason as BackupRunRow["purgeReason"],
    createdAt: isoTimestamp(r.created_at)!,
    completedAt: isoTimestamp(r.completed_at),
  }));

  // Scheduled backups run on the background worker — surface when it's down.
  let workerOnline = false;
  try {
    const heartbeat = await getWorkerHeartbeat();
    workerOnline = heartbeat !== null && Date.now() - Date.parse(heartbeat) < 90_000;
  } catch {
    workerOnline = false;
  }

  return (
    <ListPageLayout
      header={
        <PageHeader
          back={{ href: "/admin", label: tHub("title") }}
          title="Backups"
          description="Download a complete copy of this organization's data, schedule automatic backups to object storage, and control how many are retained."
        />
      }
    >
      <BackupManager
        policy={policy}
        runs={runs}
        s3Enabled={s3Enabled}
        workerOnline={workerOnline}
      />
    </ListPageLayout>
  );
}
