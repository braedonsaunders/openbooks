import { sql } from "drizzle-orm";
import { connectionAuditChanges } from "@openbooks/schema/src/connections.ts";
import { db, schema } from "../platform/db.ts";
import { getConnection, listConnections, type ConnectionRow } from "./connection.ts";

export type ConnectionDashboardData = {
  connections: ConnectionRow[];
  runs: Record<string, unknown>[];
  latestRuns: Record<string, unknown>[];
  currencies: { code: string; name: string }[];
  qbdStatuses: {
    connectionId: string;
    heartbeat: Date | null;
    captureStatus: string | null;
    captureProgress: Record<string, number> | null;
  }[];
  resolvedDeletions: { connectionId: string; sourceRef: string }[];
};

export type ConnectionProbeRow = ConnectionRow & { updatedAt: Date | string | null };

export async function loadConnectionProbeRow(
  orgId: string,
  id: string,
): Promise<ConnectionProbeRow | null> {
  const rows = await db.execute<ConnectionProbeRow>(
    sql`
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
  `,
    "objects",
  );
  return rows[0] ?? null;
}

export async function writeConnectionProbeOutcome(
  orgId: string,
  id: string,
  row: ConnectionProbeRow,
  status: string,
  lastError: string | null,
): Promise<boolean> {
  const written = await db.execute<{ id: string }>(
    sql`
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
  `,
    "objects",
  );
  return Boolean(written[0]);
}

/** Load organization-scoped connection and run metadata for the setup console. */
export async function loadConnectionDashboardData(orgId: string): Promise<ConnectionDashboardData> {
  const connections = await listConnections(orgId);
  const runs = await db.execute<Record<string, unknown>>(
    sql`
    select id, connection_id as "connectionId", source, kind, status,
           started_at as "startedAt", finished_at as "finishedAt",
           synced_through as "syncedThrough", stats, progress, error_message as "errorMessage", triggered_by as "triggeredBy"
      from sync_runs where org_id = ${orgId} order by started_at desc limit 200`,
    "objects",
  );
  const latestRuns = await db.execute<Record<string, unknown>>(
    sql`
    select distinct on (connection_id, kind)
           id, connection_id as "connectionId", source, kind, status,
           started_at as "startedAt", finished_at as "finishedAt",
           synced_through as "syncedThrough", stats, progress,
           error_message as "errorMessage", triggered_by as "triggeredBy"
      from sync_runs
     where org_id = ${orgId} and connection_id is not null
     order by connection_id, kind, started_at desc, id desc`,
    "objects",
  );
  const currencies = await db.execute<{ code: string; name: string }>(
    sql`
    select code, name from currencies order by code`,
    "objects",
  );
  const qbdStatuses = await db.execute<ConnectionDashboardData["qbdStatuses"][number]>(
    sql`
    select c.id as "connectionId",
           (select max(s.last_seen_at) from qbd_sessions s where s.connection_id = c.id and s.org_id = c.org_id) as heartbeat,
           capture.status as "captureStatus", capture.progress as "captureProgress"
      from connections c
      left join lateral (
        select status, progress from qbd_captures qc
         where qc.connection_id = c.id and qc.org_id = c.org_id order by qc.created_at desc limit 1
      ) capture on true
     where c.org_id = ${orgId} and c.source = 'qbd'`,
    "objects",
  );
  const resolvedDeletions = await db.execute<ConnectionDashboardData["resolvedDeletions"][number]>(
    sql`
    select connection_id as "connectionId", source_ref as "sourceRef"
      from source_deletion_resolutions where org_id = ${orgId}`,
    "objects",
  );
  return { connections, runs, latestRuns, currencies, qbdStatuses, resolvedDeletions };
}

/** Create a connection and its audit event in the same transaction. */
export async function createConnectionRecord(input: {
  orgId: string;
  actorId: string;
  source: string;
  displayName: string;
  authKind: string;
  status: string;
  config: Record<string, unknown>;
  secrets: string | null;
}): Promise<string> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(schema.connections)
      .values({
        orgId: input.orgId,
        source: input.source,
        displayName: input.displayName,
        authKind: input.authKind,
        status: input.status,
        config: input.config,
        secrets: input.secrets,
        createdBy: input.actorId,
        updatedBy: input.actorId,
      })
      .returning();
    if (!row) throw new Error("connection insert returned no row");
    await tx.insert(schema.auditLog).values({
      orgId: input.orgId,
      tableName: "connections",
      rowId: row.id,
      action: "insert",
      changes: connectionAuditChanges({
        event: "connection_created",
        before: null,
        after: row,
        credentialsChanged: input.secrets != null,
      }),
      actorId: input.actorId,
    });
    return row.id;
  });
}

/** Delete a connection while preserving its run history and audit evidence. */
export async function deleteConnectionRecord(
  orgId: string,
  id: string,
  actorId: string,
): Promise<string | null> {
  const existing = await getConnection(orgId, id);
  if (!existing) return null;
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      update sync_runs
         set connection_id = null
       where org_id = ${orgId} and connection_id = ${id}
    `);
    const removed = await tx.execute<{ id: string }>(
      sql`
      delete from connections
       where org_id = ${orgId} and id = ${id}
       returning id
    `,
      "objects",
    );
    if (!removed[0]) return null;
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values (
        ${orgId}, 'connections', ${id}, 'delete',
        ${JSON.stringify(
          connectionAuditChanges({
            event: "connection_deleted",
            before: existing,
            after: null,
            credentialsChanged: existing.secrets != null,
          }),
        )}::jsonb,
        ${actorId}
      )
    `);
    return removed[0].id;
  });
}
