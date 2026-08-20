import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { auditBackupEvent, getBackupObject } from "@openbooks/engine/src/backup.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { contentDisposition } from "../../../../../../lib/export";
import { isUuid } from "../../../../../../lib/list-params";

export const runtime = "nodejs";

/**
 * Download a stored backup object from S3 (streamed through, never buffered).
 * The download is audit-logged — it is a disclosure of the full dataset.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
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
      purged_at: string | null;
      sha256: string | null;
      byte_size: string | null;
    }>(sql`
    select id, file_name, object_key, status, purged_at, sha256, byte_size::text as byte_size
      from backup_runs where id = ${id} and org_id = ${orgId}`));
  const run = res.rows[0];
  if (!run || run.status !== "completed" || run.purged_at || !run.object_key || !run.sha256 || !run.byte_size) {
    return NextResponse.json({ error: "backup not found" }, { status: 404 });
  }

  await auditBackupEvent({
    orgId,
    tableName: "backup_runs",
    rowId: run.id,
    actorId: actor.id,
    changes: { event: "backup_download", delivery: "stored", fileName: run.file_name },
  });

  let object;
  try {
    object = await getBackupObject(run.object_key);
  } catch (err) {
    if ((err as { name?: string }).name === "NoSuchKey") {
      return NextResponse.json({ error: "backup object is missing from storage" }, { status: 404 });
    }
    throw err;
  }
  if (!object.Body) {
    return NextResponse.json({ error: "backup object is missing from storage" }, { status: 404 });
  }
  if (
    object.Metadata?.sha256 !== run.sha256 ||
    typeof object.ContentLength !== "number" ||
    String(object.ContentLength) !== run.byte_size
  ) {
    console.error(`[backup] stored object metadata mismatch for run ${run.id}`);
    return NextResponse.json({ error: "backup object failed integrity metadata validation" }, { status: 502 });
  }

  const base = (run.file_name ?? "backup").replace(/\.json\.gz$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/gzip",
    "Content-Disposition": contentDisposition("attachment", base, "json.gz"),
    "Cache-Control": "no-store",
    "Content-Digest": `sha-256=:${Buffer.from(run.sha256, "hex").toString("base64")}:`,
    "X-OpenBooks-SHA256": run.sha256,
  };
  if (typeof object.ContentLength === "number") {
    headers["Content-Length"] = String(object.ContentLength);
  }
  return new NextResponse(Readable.toWeb(object.Body as Readable) as unknown as ReadableStream, {
    status: 200,
    headers,
  });
}
