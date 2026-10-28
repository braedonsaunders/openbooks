import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import type { Authz } from "@/lib/authz";
import { queueManualBackup } from "@/lib/backup-queue";

export const runtime = "nodejs";

/**
 * "Back up now" — queue a manual backup to S3 object storage. The run is
 * recorded immediately (status 'queued') so the UI can track it; the worker
 * claims and executes it. Manual runs count toward retention like any other.
 */
export async function queueBackupAction(gate: Authz) {
  const actor = gate.user;
  const { orgId } = actor;

  const result = await queueManualBackup(orgId, actor.id);
  if (result.kind === "storage_unavailable") {
    return NextResponse.json(
      {
        error:
          "S3 object storage is not configured on this deployment — stored backups are unavailable",
      },
      { status: 400 },
    );
  }
  if (result.kind === "already_running") {
    return NextResponse.json({ error: "a backup is already in progress" }, { status: 409 });
  }
  if (result.kind === "queue_failed") {
    return NextResponse.json({ error: "could not queue backup" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, runId: result.runId });
}

export const POST = defineRoute({
  permission: "admin.backups.manage",
  feature: {
    none: "Manual backup runs are governed by backup management permission and organization-wide backup policy.",
  },
  scope: "unrestricted",
  handler: async ({ authz }) => queueBackupAction(authz),
});
