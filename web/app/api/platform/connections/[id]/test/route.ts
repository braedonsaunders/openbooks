import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  buildSource,
  getConnection,
} from "@openbooks/engine/src/sync/connection.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { storageIdentityError } from "../../_storage-identity";
import { connectionConfigUrlRefusal } from "../../_connector-guard";

export const runtime = "nodejs";
export const maxDuration = 60;

type ConnectionVersion = {
  updatedAt: Date | string | null;
  config: unknown;
  secrets: string | null;
};

async function loadConnectionVersion(
  orgId: string,
  id: string,
): Promise<ConnectionVersion | null> {
  const snapshot = await db.execute<ConnectionVersion>(sql`
    select updated_at as "updatedAt", config, secrets
      from connections
     where id = ${id} and org_id = ${orgId}
  `);
  return snapshot.rows[0] ?? null;
}

async function writeProbeOutcome(
  orgId: string,
  id: string,
  version: ConnectionVersion,
  status: string,
  lastError: string | null,
): Promise<boolean> {
  const written = await db.execute<{ id: string }>(sql`
    update connections
       set status = ${status},
           last_error = ${lastError},
           updated_at = now()
     where id = ${id}
       and org_id = ${orgId}
       and updated_at is not distinct from ${version.updatedAt}
       and config is not distinct from ${JSON.stringify(version.config ?? {})}::jsonb
       and secrets is not distinct from ${version.secrets}
     returning id
  `);
  return Boolean(written.rows[0]);
}

/**
 * Test a connection's credentials and persist the probe outcome onto that
 * same version of the row (status / last_error). A concurrent config or
 * credential change leaves the new row untouched.
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
  const version = await loadConnectionVersion(gate.user.orgId, id);
  if (!version) return NextResponse.json({ error: "not found" }, { status: 404 });

  const stale = () =>
    NextResponse.json(
      {
        error:
          "connection changed during the test; retry against the current configuration",
        errorCode: "CONNECTION_CHANGED",
      },
      { status: 409 },
    );

  try {
    const source = buildSource(conn);
    if (source.ping) {
      const r = await source.ping();
      const status = r.ok ? "active" : "error";
      const lastError = r.ok ? null : (r.detail ?? "connection ping failed");
      const matched = await writeProbeOutcome(
        gate.user.orgId,
        id,
        version,
        status,
        lastError,
      );
      if (!matched) return stale();
      return NextResponse.json(
        { ok: r.ok, detail: r.detail },
        { status: r.ok ? 200 : 422 },
      );
    }
    const tb = await source.trialBalance();
    const matched = await writeProbeOutcome(
      gate.user.orgId,
      id,
      version,
      "active",
      null,
    );
    if (!matched) return stale();
    return NextResponse.json({
      ok: true,
      detail: `${tb.length} accounts in trial balance`,
    });
  } catch (e) {
    const message = (e as Error).message;
    const matched = await writeProbeOutcome(
      gate.user.orgId,
      id,
      version,
      "error",
      message,
    );
    if (!matched) return stale();
    return NextResponse.json({ ok: false, error: message }, { status: 422 });
  }
}
