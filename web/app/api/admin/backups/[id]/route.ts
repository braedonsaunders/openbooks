import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { auditBackupEvent, deleteBackupObject } from "@openbooks/engine/src/backup.ts";
import { guardPermission } from "../../../../../lib/authz";
import { isUuid } from "../../../../../lib/list-params";

export const runtime = "nodejs";

/**
 * Delete a stored backup ahead of rotation. The S3 object is removed and the
 * ledger row is stamped (purged_at, purge_reason='deleted') — the row is kept
 * as evidence. In-progress runs can't be deleted.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("admin.backups.manage");
  if (gate instanceof NextResponse) return gate;
  const actor = gate.user;
  const { orgId } = actor;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const res = (await db.execute<{
      id: string;
      file_name: string | null;
      object_key: string | null;
      status: string;
      kind: string;
      byte_size: number | null;
      sha256: string | null;
      purged_at: string | null;
    }>(sql`
    select id, file_name, object_key, status, kind, byte_size, sha256, purged_at
      from backup_runs where id = ${id} and org_id = ${orgId}`));
  const run = res.rows[0];
  if (!run) return NextResponse.json({ error: "backup not found" }, { status: 404 });
  if (run.purged_at) {
    return NextResponse.json({ error: "backup was already purged" }, { status: 409 });
  }
  if (run.status === "queued" || run.status === "running") {
    return NextResponse.json({ error: "cannot delete a backup while it is in progress" }, { status: 409 });
  }

  // Storage first: only stamp the ledger once the object is actually gone, so
  // a storage failure can be retried instead of silently orphaning the object.
  if (run.object_key) {
    try {
      await deleteBackupObject(run.object_key);
    } catch (err) {
      console.error(`[backup] delete failed for ${run.object_key}:`, (err as Error).message);
      return NextResponse.json(
        { error: "could not delete the backup object from storage — try again" },
        { status: 502 },
      );
    }
  }

  await db.execute(sql`
    update backup_runs
       set purged_at = now(), purge_reason = 'deleted', updated_at = now()
     where id = ${run.id}`);

  await auditBackupEvent({
    orgId,
    tableName: "backup_runs",
    rowId: run.id,
    actorId: actor.id,
    changes: {
      event: "backup_deleted",
      kind: run.kind,
      fileName: run.file_name,
      byteSize: run.byte_size,
      sha256: run.sha256,
    },
  });

  return NextResponse.json({ ok: true });
}
