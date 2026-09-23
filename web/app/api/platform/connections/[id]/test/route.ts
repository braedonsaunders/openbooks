import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  buildSource,
  type ConnectionRow,
} from "@openbooks/engine/src/sync/connection.ts";
import { guardPermission, guardUnrestrictedScope } from "../../../../../../lib/authz";
import { storageIdentityError } from "../../_storage-identity";
import { connectionConfigUrlRefusal } from "../../_connector-guard";

export const runtime = "nodejs";
export const maxDuration = 60;

type ProbeRow = ConnectionRow & { updatedAt: Date | string | null };

async function loadProbeRow(orgId: string, id: string): Promise<ProbeRow | null> {
  const loaded = await db.execute<ProbeRow>(sql`
    select id, org_id as "orgId", source, display_name as "displayName",
           auth_kind as "authKind", status, config, secrets,
           mirror_enabled as "mirrorEnabled", mirror_schedule as "mirrorSchedule",
           posted_change_policy as "postedChangePolicy",
           posted_change_authorized_by as "postedChangeAuthorizedBy",
           posted_change_authorized_at as "postedChangeAuthorizedAt",
           cursor, last_run_at as "lastRunAt", last_error as "lastError",
           updated_at as "updatedAt"
      from connections
     where id = ${id} and org_id = ${orgId}
  `);
  return loaded.rows[0] ?? null;
}

async function writeProbeOutcome(
  orgId: string,
  id: string,
  row: ProbeRow,
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
       and updated_at is not distinct from ${row.updatedAt}
       and config is not distinct from ${JSON.stringify(row.config ?? {})}::jsonb
       and secrets is not distinct from ${row.secrets}
     returning id
  `);
  return Boolean(written.rows[0]);
}

/**
 * Test a connection's credentials and persist the probe outcome onto that
 * same version of the row (status / last_error). Probe target and version
 * token come from one read; a concurrent change leaves the new row untouched.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  const scopeDenied = guardUnrestrictedScope(gate);
  if (scopeDenied) return scopeDenied;
  const { id } = await params;
  const row = await loadProbeRow(gate.user.orgId, id).catch((e) => {
    if (storageIdentityError(e)) return null;
    throw e;
  });
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  const urlError = await connectionConfigUrlRefusal(row.config);
  if (urlError) {
    // A refused connector URL is a validation refusal on a found connection
    // (fix the connector URL and retry), never a missing connection.
    return NextResponse.json(
      { error: urlError, errorCode: "CONNECTOR_URL_REFUSED" },
      { status: 422 },
    );
  }

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
    const source = buildSource(row);
    if (source.ping) {
      const r = await source.ping();
      const status = r.ok ? "active" : "error";
      const lastError = r.ok ? null : (r.detail ?? "connection ping failed");
      const matched = await writeProbeOutcome(
        gate.user.orgId,
        id,
        row,
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
      row,
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
      row,
      "error",
      message,
    );
    if (!matched) return stale();
    return NextResponse.json({ ok: false, error: message }, { status: 422 });
  }
}
