import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { auditBackupEvent } from "@openbooks/engine/src/backup.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { contentDisposition } from "../../../../../../lib/export";
import { isUuid } from "../../../../../../lib/list-params";

export const runtime = "nodejs";

/** Restore-CLI-compatible authenticated evidence for one stored archive. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("admin.backups.manage");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const result = (await db.execute(sql`
    select id, org_id, file_name, status, purged_at, sha256,
           byte_size::text as byte_size, table_count, row_count::text as row_count,
           created_at
      from backup_runs
     where id = ${id} and org_id = ${gate.user.orgId}`)) as unknown as {
    rows: {
      id: string;
      org_id: string;
      file_name: string | null;
      status: string;
      purged_at: string | null;
      sha256: string | null;
      byte_size: string | null;
      table_count: number | null;
      row_count: string | null;
      created_at: Date | string;
    }[];
  };
  const run = result.rows[0];
  if (!run || run.status !== "completed" || run.purged_at || !run.sha256 || !run.file_name) {
    return NextResponse.json({ error: "backup not found" }, { status: 404 });
  }
  const byteSize = run.byte_size === null ? null : Number(run.byte_size);
  const rowCount = run.row_count === null ? undefined : Number(run.row_count);
  if (
    (byteSize !== null && !Number.isSafeInteger(byteSize)) ||
    (rowCount !== undefined && !Number.isSafeInteger(rowCount))
  ) {
    return NextResponse.json({ error: "backup counts exceed manifest numeric limits" }, { status: 500 });
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
      "Content-Disposition": contentDisposition("attachment", `${base}.json.gz`, "manifest.json"),
      "Cache-Control": "no-store",
    },
  });
}
