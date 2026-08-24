import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { s3Enabled } from "@openbooks/engine/src/file-storage.ts";
import { enqueueBackupRun } from "@openbooks/jobs";
import { guardPermission } from "../../../../../lib/authz";

export const runtime = "nodejs";

/**
 * "Back up now" — queue a manual backup to S3 object storage. The run is
 * recorded immediately (status 'queued') so the UI can track it; the worker
 * claims and executes it. Manual runs count toward retention like any other.
 */
export async function POST() {
  const gate = await guardPermission("admin.backups.manage");
  if (gate instanceof NextResponse) return gate;
  const actor = gate.user;
  const { orgId } = actor;

  if (!s3Enabled) {
    return NextResponse.json(
      { error: "S3 object storage is not configured on this deployment — stored backups are unavailable" },
      { status: 400 },
    );
  }

  // The partial unique index on backup_runs is the single in-flight guard.
  // Relying on a preceding SELECT would leave a check-then-insert race between
  // concurrent requests and the scheduler.
  let run: { rows: { id: string }[] };
  try {
    run = (await db.execute<{ id: string }>(sql`
      insert into backup_runs (org_id, kind, status, actor_id)
      values (${orgId}, 'manual', 'queued', ${actor.id})
      returning id`));
  } catch (error) {
    const postgresError = error as { code?: string; constraint?: string };
    if (
      postgresError.code === "23505" &&
      postgresError.constraint === "backup_runs_one_inflight_per_org"
    ) {
      return NextResponse.json({ error: "a backup is already in progress" }, { status: 409 });
    }
    throw error;
  }
  const runId = run.rows[0]!.id;

  await enqueueBackupRun({ op: "run", runId, orgId }, { jobId: runId });

  return NextResponse.json({ ok: true, runId });
}
