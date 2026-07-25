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

  // One in-flight backup per org: a second run while one is queued/running
  // would race the same snapshot tables and double the storage churn.
  const active = (await db.execute(sql`
    select id from backup_runs
     where org_id = ${orgId} and status in ('queued', 'running')
     limit 1`)) as unknown as { rows: { id: string }[] };
  if (active.rows.length > 0) {
    return NextResponse.json({ error: "a backup is already in progress" }, { status: 409 });
  }

  const run = (await db.execute(sql`
    insert into backup_runs (org_id, kind, status, actor_id)
    values (${orgId}, 'manual', 'queued', ${actor.id})
    returning id`)) as unknown as { rows: { id: string }[] };
  const runId = run.rows[0].id;

  await enqueueBackupRun({ op: "run", runId, orgId }, { jobId: runId });

  return NextResponse.json({ ok: true, runId });
}
