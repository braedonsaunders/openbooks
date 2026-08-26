import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { db } from "@openbooks/engine/src/db.ts";
import {
  ensureSftpServer,
  loadDaemonConfig,
  sftpDaemonConfigAuditSnapshot,
  updateDaemonConfig,
} from "@openbooks/engine/src/sftp/manager.ts";
import { auditSetupChange } from "../../../../../lib/setup/audit";
import { guardSuperAdmin } from "../../../../../lib/super-admin";

export const runtime = "nodejs";

/**
 * audit_log.row_id is a uuid, but the daemon's singleton row is the text id
 * 'default' — anchor its evidence on the deterministic uuid derived from that
 * identity so every mutation of the same row lands on one stable anchor.
 */
function daemonAuditRowId(): string {
  const bytes = [...createHash("sha256").update("sftp_daemon:default").digest("hex").slice(0, 32)];
  bytes[12] = "5"; // RFC 4122 version: name-derived
  bytes[16] = (((parseInt(bytes[16]!, 16) & 0x3) | 0x8)).toString(16); // variant
  const hex = bytes.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Configure the global SFTP daemon (enable/disable, port, advertised host).
 * The daemon is one listener shared by every tenant, so this is platform
 * super-admin authority — never an organization feature.
 *
 * The configuration write and its secret-free audit evidence (the host key is
 * private key material and never appears in evidence) commit as ONE unit: a
 * failed audit insert rolls the configuration back. Only after that unit
 * commits does the listener reconcile — never binding a port the database no
 * longer says we own.
 */
export async function PATCH(req: Request) {
  const gate = await guardSuperAdmin();
  if (gate instanceof NextResponse) return gate;
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as { enabled?: boolean; port?: number; advertisedHost?: string | null };
  if (body.port !== undefined && (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535)) {
    return NextResponse.json({ error: "port must be between 1 and 65535" }, { status: 400 });
  }
  const cfg = await db.transaction(async (tx) => {
    const before = sftpDaemonConfigAuditSnapshot(await loadDaemonConfig(tx));
    const after = await updateDaemonConfig(
      {
        enabled: body.enabled,
        port: body.port,
        advertisedHost: body.advertisedHost !== undefined ? (body.advertisedHost?.trim() || null) : undefined,
      },
      gate.user.id,
      tx,
    );
    await auditSetupChange({
      orgId: gate.user.orgId,
      table: "sftp_daemon",
      rowId: daemonAuditRowId(),
      action: "update",
      changes: { before, after: sftpDaemonConfigAuditSnapshot(after) },
      actorId: gate.user.id,
    }, tx);
    return after;
  });
  await ensureSftpServer();
  return NextResponse.json({ ok: true, enabled: cfg.enabled, port: cfg.port, advertisedHost: cfg.advertisedHost });
}
