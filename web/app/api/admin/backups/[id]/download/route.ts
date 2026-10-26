import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { auditBackupEvent, getBackupObject } from "@openbooks/engine/backup/backup";
import { findStoredBackupArchive } from "@openbooks/engine/backup/backup-read";
import type { Authz } from "@/lib/authz";
import { contentDisposition } from "@/lib/export";
import { isUuid } from "@/lib/list-params";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

/**
 * Download a stored backup object from S3 (streamed through, never buffered).
 * The download is audit-logged — it is a disclosure of the full dataset.
 */
async function legacyGET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
  gate: Authz,
) {
  const actor = gate.user;
  const { orgId } = actor;
  const { id } = await params;
  if (!isUuid(id)) return notFound("record");

  const run = await findStoredBackupArchive(orgId, id);
  if (
    !run ||
    run.status !== "completed" ||
    run.purged_at ||
    !run.object_key ||
    !run.sha256 ||
    !run.byte_size
  ) {
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
    return NextResponse.json(
      { error: "backup object failed integrity metadata validation" },
      { status: 502 },
    );
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

export const GET = defineRoute({
  permission: "admin.backups.manage",
  feature: {
    none: "Backup downloads are governed by backup management permission and organization-wide backup policy.",
  },
  scope: "unrestricted",
  params: z.object({ id: z.string() }),
  handler: async ({ request, params, authz }) =>
    legacyGET(request, { params: Promise.resolve(params) }, authz),
});
