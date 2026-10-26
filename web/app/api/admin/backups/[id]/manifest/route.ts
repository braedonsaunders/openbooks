import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { auditBackupEvent } from "@openbooks/engine/backup/backup";
import { findStoredBackupManifest } from "@openbooks/engine/backup/backup-read";
import type { Authz } from "@/lib/authz";
import { contentDisposition } from "@/lib/export";
import { isUuid } from "@/lib/list-params";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

/** Restore-CLI-compatible authenticated evidence for one stored archive. */
async function legacyGET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
  gate: Authz,
) {
  const { id } = await params;
  if (!isUuid(id)) return notFound("record");

  const run = await findStoredBackupManifest(gate.user.orgId, id);
  if (!run || run.status !== "completed" || run.purged_at || !run.sha256 || !run.file_name) {
    return NextResponse.json({ error: "backup not found" }, { status: 404 });
  }
  const byteSize = run.byte_size === null ? null : Number(run.byte_size);
  const rowCount = run.row_count === null ? undefined : Number(run.row_count);
  if (
    (byteSize !== null && !Number.isSafeInteger(byteSize)) ||
    (rowCount !== undefined && !Number.isSafeInteger(rowCount))
  ) {
    return NextResponse.json(
      { error: "backup counts exceed manifest numeric limits" },
      { status: 500 },
    );
  }
  const manifest = {
    format: "openbooks-local-backup-manifest",
    version: 1,
    orgId: run.org_id,
    createdAt: new Date(run.created_at).toISOString(),
    file: run.file_name,
    byteSize,
    sha256: run.sha256,
    tableCount: run.table_count ?? undefined,
    rowCount,
    source: { storage: "s3", runId: run.id },
  };
  await auditBackupEvent({
    orgId: run.org_id,
    tableName: "backup_runs",
    rowId: run.id,
    actorId: gate.user.id,
    changes: { event: "backup_manifest_download", sha256: run.sha256 },
  });
  const base = run.file_name.replace(/\.json\.gz$/, "");
  return new NextResponse(`${JSON.stringify(manifest, null, 2)}\n`, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": contentDisposition("attachment", base, "manifest.json"),
      "Cache-Control": "no-store",
    },
  });
}

export const GET = defineRoute({
  permission: "admin.backups.manage",
  feature: {
    none: "Backup manifests are governed by backup management permission and organization-wide backup policy.",
  },
  scope: "unrestricted",
  params: z.object({ id: z.string() }),
  handler: async ({ request, params, authz }) =>
    legacyGET(request, { params: Promise.resolve(params) }, authz),
});
