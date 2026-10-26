import { sql } from "drizzle-orm";
import { auditBackupEvent, type BackupPolicyShape } from "./backup.ts";
import { db, withOrgTransaction } from "../platform/db.ts";

export interface BackupPolicyValues extends BackupPolicyShape {
  enabled: boolean;
  maxKeep: number;
}

export async function saveBackupPolicy(
  orgId: string,
  actorId: string,
  policy: BackupPolicyValues,
  nextRunAt: string | null,
): Promise<void> {
  await withOrgTransaction(orgId, async () => {
    // Serialize absent-row creation as well as updates: FOR UPDATE has nothing
    // to lock when this organization has not configured a policy yet.
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"backup-policy:" + orgId}, 0))`,
    );
    const existing = await db.execute<{
      enabled: boolean;
      frequency: string;
      hour_utc: number;
      day_of_week: number;
      day_of_month: number;
      max_keep: number;
    }>(
      sql`
      select enabled, frequency, hour_utc, day_of_week, day_of_month, max_keep
        from backup_policies where org_id = ${orgId} for update`,
      "objects",
    );
    const before = existing[0];

    await db.execute(sql`
      insert into backup_policies
        (org_id, enabled, frequency, hour_utc, day_of_week, day_of_month, max_keep, next_run_at, created_by, updated_by)
      values
        (${orgId}, ${policy.enabled}, ${policy.frequency}, ${policy.hourUtc}, ${policy.dayOfWeek}, ${policy.dayOfMonth}, ${policy.maxKeep},
         ${nextRunAt}, ${actorId}, ${actorId})
      on conflict (org_id) do update set
        enabled = excluded.enabled,
        frequency = excluded.frequency,
        hour_utc = excluded.hour_utc,
        day_of_week = excluded.day_of_week,
        day_of_month = excluded.day_of_month,
        max_keep = excluded.max_keep,
        next_run_at = excluded.next_run_at,
        updated_at = now(),
        updated_by = excluded.updated_by
      where backup_policies.org_id = ${orgId}`);

    const after = (
      await db.execute<{
        enabled: boolean;
        frequency: string;
        hour_utc: number;
        day_of_week: number;
        day_of_month: number;
        max_keep: number;
      }>(
        sql`
      select enabled, frequency, hour_utc, day_of_week, day_of_month, max_keep
        from backup_policies where org_id = ${orgId} for update`,
        "objects",
      )
    )[0];
    if (!after) throw new Error("backup policy upsert matched no row");
    const changes: Record<string, unknown> = { event: "backup_policy_updated" };
    const fields = [
      ["enabled", before?.enabled ?? null, after.enabled],
      ["frequency", before?.frequency ?? null, after.frequency],
      ["hourUtc", before?.hour_utc ?? null, after.hour_utc],
      ["dayOfWeek", before?.day_of_week ?? null, after.day_of_week],
      ["dayOfMonth", before?.day_of_month ?? null, after.day_of_month],
      ["maxKeep", before?.max_keep ?? null, after.max_keep],
    ] as const;
    for (const [key, from, to] of fields) {
      if (from !== to) changes[key] = [from, to];
    }
    await auditBackupEvent({
      orgId,
      tableName: "backup_policies",
      rowId: orgId,
      actorId,
      changes,
    });
  });
}
