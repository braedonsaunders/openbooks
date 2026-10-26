import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { BackupStorageDeleteError, purgeBackupRun } from "@openbooks/engine/backup/backup";
import { findStoredBackupForPurge } from "@openbooks/engine/backup/backup-read";
import type { Authz } from "@/lib/authz";
import { isUuid } from "@/lib/list-params";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

/**
 * Delete a stored backup ahead of rotation. The S3 object is removed and the
 * ledger row is stamped (purged_at, purge_reason='deleted') — the row is kept
 * as evidence. In-progress runs can't be deleted.
 */
async function legacyDELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
  gate: Authz,
) {
  const actor = gate.user;
  const { orgId } = actor;
  const { id } = await params;
  if (!isUuid(id)) return notFound("record");

  const run = await findStoredBackupForPurge(orgId, id);
  if (!run) return NextResponse.json({ error: "backup not found" }, { status: 404 });
  if (run.purged_at) {
    return NextResponse.json({ error: "backup was already purged" }, { status: 409 });
  }
  if (run.status === "queued" || run.status === "running") {
    return NextResponse.json(
      { error: "cannot delete a backup while it is in progress" },
      { status: 409 },
    );
  }

  let purged: boolean;
  try {
    purged = await purgeBackupRun({
      orgId,
      runId: run.id,
      objectKey: run.object_key,
      actorId: actor.id,
      reason: "deleted",
      kind: run.kind,
      fileName: run.file_name,
      byteSize: run.byte_size,
      sha256: run.sha256,
    });
  } catch (error) {
    if (error instanceof BackupStorageDeleteError) {
      const message = error.cause instanceof Error ? error.cause.message : String(error.cause);
      console.error(`[backup] delete failed for ${run.object_key}:`, message);
      return NextResponse.json(
        { error: "could not delete the backup object from storage — try again" },
        { status: 502 },
      );
    }
    throw error;
  }
  if (!purged) return NextResponse.json({ error: "backup was already purged" }, { status: 409 });

  return NextResponse.json({ ok: true });
}

export const DELETE = defineRoute({
  permission: "admin.backups.manage",
  feature: {
    none: "Backup deletion is governed by backup management permission and organization-wide retention policy.",
  },
  scope: "unrestricted",
  params: z.object({ id: z.string() }),
  handler: async ({ request, params, authz }) =>
    legacyDELETE(request, { params: Promise.resolve(params) }, authz),
});
