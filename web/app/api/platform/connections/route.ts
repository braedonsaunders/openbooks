import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, schema } from "@openbooks/engine/src/db.ts";
import { sealJson } from "@openbooks/engine/src/secrets.ts";
import {
  listConnections,
  sourceType,
  SOURCE_TYPES,
  validateSourceConfig,
  validateSourceSecret,
} from "@openbooks/engine/src/sync/connection.ts";
import { businessToday } from "@openbooks/engine/src/business-date.ts";
import { connectionAuditChanges } from "@openbooks/schema/src/connections.ts";
import { guardPermission } from "../../../../lib/authz";

export const runtime = "nodejs";

/** Strip the sealed credential blob before anything leaves the server. */
function toClient(c: Awaited<ReturnType<typeof listConnections>>[number]) {
  return {
    id: c.id,
    source: c.source,
    displayName: c.displayName,
    authKind: c.authKind,
    status: c.status,
    config: c.config,
    mirrorEnabled: c.mirrorEnabled,
    mirrorSchedule: c.mirrorSchedule,
    postedChangePolicy: c.postedChangePolicy,
    postedChangeAuthorizedAt: c.postedChangeAuthorizedAt,
    cursor: c.cursor,
    lastRunAt: c.lastRunAt,
    lastError: c.lastError,
    hasSecrets: Boolean(c.secrets),
  };
}

/** List this tenant's connections + the catalogue of source types you can add. */
export async function GET() {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  const orgId = gate.user.orgId;
  const rows = await listConnections(orgId);
  const runs = (await db.execute<Record<string, unknown>>(sql`
    select id, connection_id as "connectionId", source, kind, status,
           started_at as "startedAt", finished_at as "finishedAt",
           synced_through as "syncedThrough", stats, progress, error_message as "errorMessage", triggered_by as "triggeredBy"
      from sync_runs where org_id = ${orgId} order by started_at desc limit 200`));
  // Configured currencies power any `optionsSource: 'currencies'` config field.
  const currencies = (await db.execute<{ code: string; name: string }>(sql`
    select code, name from currencies order by code`));
  const qbdStatuses = (await db.execute<{
      connectionId: string;
      heartbeat: Date | null;
      captureStatus: string | null;
      captureProgress: Record<string, number> | null;
    }>(sql`
    select c.id as "connectionId",
           (select max(s.last_seen_at) from qbd_sessions s where s.connection_id = c.id and s.org_id = c.org_id) as heartbeat,
           capture.status as "captureStatus", capture.progress as "captureProgress"
      from connections c
      left join lateral (
        select status, progress from qbd_captures qc
         where qc.connection_id = c.id and qc.org_id = c.org_id order by qc.created_at desc limit 1
      ) capture on true
     where c.org_id = ${orgId} and c.source = 'qbd'`));
  const qbdByConnection = new Map(
    qbdStatuses.rows.map((row) => [row.connectionId, row]),
  );
  const runHealth = new Map<
    string,
    { mirror?: Record<string, unknown>; attachments?: Record<string, unknown> }
  >();
  for (const run of runs.rows) {
    const connectionId =
      typeof run.connectionId === "string" ? run.connectionId : null;
    if (!connectionId) continue;
    const health = runHealth.get(connectionId) ?? {};
    if (run.kind === "incremental" && !health.mirror) health.mirror = run;
    if (run.kind === "attachments" && !health.attachments)
      health.attachments = run;
    runHealth.set(connectionId, health);
  }
  const resolvedDeletions = (await db.execute<{ connectionId: string; sourceRef: string }>(sql`
    select connection_id as "connectionId", source_ref as "sourceRef"
      from source_deletion_resolutions where org_id = ${orgId}`));
  const resolvedKeys = new Set(
    resolvedDeletions.rows.map((row) => `${row.connectionId}:${row.sourceRef}`),
  );
  return NextResponse.json({
    connections: rows.map((row) => ({
      ...toClient(row),
      qbdStatus: qbdByConnection.get(row.id) ?? null,
      runHealth: runHealth.get(row.id) ?? {},
      unresolvedSourceDeletions: (() => {
        const latest = runHealth.get(row.id)?.mirror;
        const stats = latest?.stats as
          { deletedAtSource?: unknown[] } | undefined;
        return (stats?.deletedAtSource ?? [])
          .map(String)
          .filter((sourceRef) => !resolvedKeys.has(`${row.id}:${sourceRef}`));
      })(),
    })),
    runs: runs.rows,
    currencies: currencies.rows,
    sourceTypes: SOURCE_TYPES.map((s) => ({
      source: s.source,
      displayName: s.displayName,
      authKind: s.authKind,
      blurb: s.blurb,
      configFields: s.configFields,
      secretFields: s.secretFields.map((f) => ({ ...f })),
      oauthSetup: s.oauthSetup ?? null,
    })),
  });
}

/** Create a connection. Secrets are sealed at rest and never echoed back. */
export async function POST(req: Request) {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  const orgId = gate.user.orgId;
  const actorId = gate.user.id;

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    source?: string;
    displayName?: string;
    config?: Record<string, unknown>;
    secrets?: Record<string, string>;
  };
  const manifest = sourceType(String(body.source ?? ""));
  if (!manifest)
    return NextResponse.json({ error: "unknown source type" }, { status: 400 });

  const displayName =
    String(body.displayName ?? "").trim() || manifest.displayName;
  const config = body.config ?? {};

  const configError = validateSourceConfig(manifest, config, { today: await businessToday(orgId) });
  if (configError)
    return NextResponse.json({ error: configError }, { status: 400 });

  // Seal any provided secret fields (all-or-nothing per field).
  const provided: Record<string, string> = {};
  for (const f of manifest.secretFields) {
    const v = body.secrets?.[f.key];
    if (v !== undefined && v !== null && String(v) !== "") {
      const secretError = validateSourceSecret(
        manifest.source,
        f.key,
        String(v),
      );
      if (secretError)
        return NextResponse.json({ error: secretError }, { status: 400 });
      provided[f.key] = String(v);
    }
  }
  const hasAllSecrets = manifest.secretFields.every(
    (f) => !f.required || provided[f.key],
  );
  if (manifest.source === "qbd" && !hasAllSecrets) {
    return NextResponse.json(
      { error: "Web Connector password is required" },
      { status: 400 },
    );
  }
  const sealed = Object.keys(provided).length > 0 ? sealJson(provided) : null;
  // OAuth connections still need the consent flow before they can run, even
  // once their app credentials are saved — so they start "unconfigured".
  const status =
    manifest.authKind === "oauth2"
      ? "unconfigured"
      : sealed && hasAllSecrets
        ? "active"
        : "unconfigured";

  try {
    const id = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.connections)
        .values({
          orgId,
          source: manifest.source,
          displayName,
          authKind: manifest.authKind,
          status,
          config,
          secrets: sealed,
          createdBy: actorId,
          updatedBy: actorId,
        })
        .returning();
      if (!row) throw new Error("connection insert returned no row");
      await tx.insert(schema.auditLog).values({
        orgId,
        tableName: "connections",
        rowId: row.id,
        action: "insert",
        changes: connectionAuditChanges({
          event: "connection_created",
          before: null,
          after: row,
          credentialsChanged: sealed != null,
        }),
        actorId,
      });
      return row.id;
    });
    return NextResponse.json({ id });
  } catch (e) {
    const msg = (e as { message?: string })?.message ?? "create failed";
    // Unique (org, displayName) collision → friendly message.
    if (/connections_org_name/.test(msg)) {
      return NextResponse.json(
        { error: "a connection with that name already exists" },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
