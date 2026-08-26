import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { updateDaemonConfig } from "@openbooks/engine/src/sftp/manager.ts";
import { guardSuperAdmin } from "../../../../../lib/super-admin";

export const runtime = "nodejs";

/**
 * Configure the global SFTP daemon (enable/disable, port, advertised host);
 * restarts it live. The daemon is one listener shared by every tenant, so
 * this is platform super-admin authority — never an organization feature.
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
  const cfg = await updateDaemonConfig(
    {
      enabled: body.enabled,
      port: body.port,
      advertisedHost: body.advertisedHost !== undefined ? (body.advertisedHost?.trim() || null) : undefined,
    },
    gate.user.id,
  );
  return NextResponse.json({ ok: true, enabled: cfg.enabled, port: cfg.port, advertisedHost: cfg.advertisedHost });
}
