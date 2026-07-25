import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { auditBackupEvent, backupFileBaseName, streamOrgBackup } from "@openbooks/engine/src/backup.ts";
import { guardPermission } from "../../../../../lib/authz";
import { contentDisposition } from "../../../../../lib/export";

export const runtime = "nodejs";

/**
 * "Download now" — stream a fresh, consistent full-organization backup
 * straight to the browser as a .json.gz attachment. Nothing is stored on the
 * server; the download itself is audit-logged (sensitive data disclosure).
 */
export async function GET() {
  const gate = await guardPermission("admin.backups.manage");
  if (gate instanceof NextResponse) return gate;
  const actor = gate.user;
  const { orgId } = actor;

  const orgRes = (await db.execute(sql`
    select name from orgs where id = ${orgId}`)) as unknown as { rows: { name: string }[] };
  const base = backupFileBaseName(orgRes.rows[0]?.name ?? "org");

  await auditBackupEvent({
    orgId,
    tableName: "orgs",
    rowId: orgId,
    actorId: actor.id,
    changes: { event: "backup_download", delivery: "direct", fileName: `${base}.json.gz` },
  });

  const gzip = createGzip({ level: 6 });
  // Producer runs in the background; on failure the stream is destroyed so the
  // client sees an aborted download rather than a silent truncated file.
  void streamOrgBackup(orgId, gzip).catch((err) => {
    console.error("[backup] direct download failed:", (err as Error).message);
  });

  return new NextResponse(Readable.toWeb(gzip) as unknown as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": contentDisposition("attachment", base, "json.gz"),
      "Cache-Control": "no-store",
    },
  });
}
