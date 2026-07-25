import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { auditBackupEvent, computeNextRunAt, type BackupPolicyShape } from "@openbooks/engine/src/backup.ts";
import { guardPermission } from "../../../../../lib/authz";

export const runtime = "nodejs";

/**
 * Scheduled-backup policy for the org (one row per org, keyed by org_id).
 * Upserting recomputes next_run_at from the new cadence; disabling clears it.
 * Every change is audited with before/after tuples.
 */

const FREQUENCIES = new Set(["daily", "weekly", "monthly"]);

export async function PUT(req: Request) {
  const gate = await guardPermission("admin.backups.manage");
  if (gate instanceof NextResponse) return gate;
  const actor = gate.user;
  const { orgId } = actor;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const enabled = body.enabled;
  if (typeof enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }
  const frequency = body.frequency;
  if (typeof frequency !== "string" || !FREQUENCIES.has(frequency)) {
    return NextResponse.json({ error: "frequency must be daily, weekly, or monthly" }, { status: 400 });
  }
  const intIn = (v: unknown, min: number, max: number): number | null => {
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : null;
  };
  const hourUtc = intIn(body.hourUtc, 0, 23);
  if (hourUtc === null) {
    return NextResponse.json({ error: "hourUtc must be an integer 0–23" }, { status: 400 });
  }
  const dayOfWeek = intIn(body.dayOfWeek, 0, 6);
  if (dayOfWeek === null) {
    return NextResponse.json({ error: "dayOfWeek must be an integer 0–6" }, { status: 400 });
  }
  const dayOfMonth = intIn(body.dayOfMonth, 1, 28);
  if (dayOfMonth === null) {
    return NextResponse.json({ error: "dayOfMonth must be an integer 1–28" }, { status: 400 });
  }
  const maxKeep = intIn(body.maxKeep, 1, 100);
  if (maxKeep === null) {
    return NextResponse.json({ error: "maxKeep must be an integer 1–100" }, { status: 400 });
  }

  const shape: BackupPolicyShape = {
    frequency: frequency as BackupPolicyShape["frequency"],
    hourUtc,
    dayOfWeek,
    dayOfMonth,
  };
  const nextRunAt = enabled ? computeNextRunAt(shape, new Date()).toISOString() : null;

  const existing = (await db.execute(sql`
    select enabled, frequency, hour_utc, day_of_week, day_of_month, max_keep
      from backup_policies where org_id = ${orgId}`)) as unknown as {
    rows: {
      enabled: boolean;
      frequency: string;
      hour_utc: number;
      day_of_week: number;
      day_of_month: number;
      max_keep: number;
    }[];
  };
  const before = existing.rows[0];

  await db.execute(sql`
    insert into backup_policies
      (org_id, enabled, frequency, hour_utc, day_of_week, day_of_month, max_keep, next_run_at, created_by, updated_by)
    values
      (${orgId}, ${enabled}, ${frequency}, ${hourUtc}, ${dayOfWeek}, ${dayOfMonth}, ${maxKeep},
       ${nextRunAt}, ${actor.id}, ${actor.id})
    on conflict (org_id) do update set
      enabled = excluded.enabled,
      frequency = excluded.frequency,
      hour_utc = excluded.hour_utc,
      day_of_week = excluded.day_of_week,
      day_of_month = excluded.day_of_month,
      max_keep = excluded.max_keep,
      next_run_at = excluded.next_run_at,
      updated_at = now(),
      updated_by = excluded.updated_by`);

  const after = { enabled, frequency, hour_utc: hourUtc, day_of_week: dayOfWeek, day_of_month: dayOfMonth, max_keep: maxKeep };
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
    actorId: actor.id,
    changes,
  });

  return NextResponse.json({ ok: true, nextRunAt });
}
