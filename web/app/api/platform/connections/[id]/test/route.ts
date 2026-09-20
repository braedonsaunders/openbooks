import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  buildSource,
  getConnection,
} from "@openbooks/engine/src/sync/connection.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { storageIdentityError } from "../../_storage-identity";

export const runtime = "nodejs";
export const maxDuration = 60;

const CONNECTOR_URL_REFUSED =
  "Connector URL must be a public http:// or https:// address. Loopback, link-local, metadata, and non-http(s) URLs are refused.";

/** Stored connector URL/host. Same refusal set as bank-feed metadata hosts. */
function connectorUrlRefusal(value: unknown): string | null {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return CONNECTOR_URL_REFUSED;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return CONNECTOR_URL_REFUSED;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const ipv4 = host.startsWith("::ffff:") ? host.slice(7) : host;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host.startsWith("fe80:") ||
    /^127(?:\.\d{1,3}){3}$/.test(ipv4) ||
    /^169\.254(?:\.\d{1,3}){2}$/.test(ipv4)
  ) {
    return CONNECTOR_URL_REFUSED;
  }
  return null;
}

function connectionConfigUrlRefusal(config: unknown): string | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const row = config as Record<string, unknown>;
  return connectorUrlRefusal(row.url) ?? connectorUrlRefusal(row.host);
}

/**
 * Test a connection's credentials without mutating anything: build the adapter
 * and run its cheap `ping()` (falling back to a trial-balance fetch). Returns a
 * friendly ok/error the wizard shows before the tenant commits to a migration.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  const conn = await getConnection(gate.user.orgId, id).catch((e) => {
    if (storageIdentityError(e)) return null;
    throw e;
  });
  if (!conn) return NextResponse.json({ error: "not found" }, { status: 404 });
  const urlError = connectionConfigUrlRefusal(conn.config);
  if (urlError) {
    return NextResponse.json(
      { error: urlError, errorCode: "CONNECTOR_URL_REFUSED" },
      { status: 404 },
    );
  }

  try {
    const source = buildSource(conn);
    if (source.ping) {
      const r = await source.ping();
      const status = r.ok ? "active" : "error";
      const lastError = r.ok ? null : (r.detail ?? "connection ping failed");
      await db.execute(
        sql`update connections set status = ${status}, last_error = ${lastError}, updated_at = now() where id = ${id} and org_id = ${gate.user.orgId}`,
      );
      return NextResponse.json({ ok: r.ok, detail: r.detail });
    }
    const tb = await source.trialBalance();
    await db.execute(
      sql`update connections set status = 'active', last_error = null, updated_at = now() where id = ${id} and org_id = ${gate.user.orgId}`,
    );
    return NextResponse.json({
      ok: true,
      detail: `${tb.length} accounts in trial balance`,
    });
  } catch (e) {
    const message = (e as Error).message;
    await db.execute(
      sql`update connections set status = 'error', last_error = ${message}, updated_at = now() where id = ${id} and org_id = ${gate.user.orgId}`,
    );
    return NextResponse.json({ ok: false, error: message }, { status: 200 });
  }
}
