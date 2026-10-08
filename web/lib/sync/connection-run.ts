import "server-only";
import { sql } from "drizzle-orm";
import { enqueueMigration, getMigrationQueue } from "@openbooks/jobs";
import { db } from "@openbooks/engine/platform/database";
import { sourceSupportsRunMode, syncConnectionRunLockKey, type ConnectionRow } from "@openbooks/engine/sync";
import { storageIdentityError } from "../../app/api/platform/connections/_storage-identity";
import { connectionConfigUrlRefusal } from "../../app/api/platform/connections/_connector-guard";

type ProbeRow = ConnectionRow & { updatedAt: Date | string | null };

export const CONNECTION_RUN_MODES = ["full_migration", "preflight", "mirror", "project_financials", "attachments"] as const;
export type ConnectionRunMode = (typeof CONNECTION_RUN_MODES)[number];

const ACTIVE_MIGRATION_JOB_STATES = new Set([
  "active",
  "delayed",
  "paused",
  "prioritized",
  "waiting",
  "waiting-children",
]);
const MUTATING_MIGRATION_MODES = [
  "full_migration",
  "mirror",
  "project_financials",
  "attachments",
  "targeted_repair",
] as const;

export type ConnectionRunOutcome = { status: number; body: Record<string, unknown> };

/**
 * Enqueue a migration or mirror pass for one connection onto the worker.
 * Returns immediately with the job id; progress lands in sync_runs. One job
 * per (connection, mode) is de-duplicated so a repeated request cannot start
 * two backfills, and every mutating mode is refused while another mutating
 * run for the connection is queued or running. The Migration & Sync page and
 * the migration assistant both start runs through this command.
 */
export async function requestConnectionRun(
  actor: { orgId: string; userId: string },
  connectionId: string,
  mode: ConnectionRunMode,
): Promise<ConnectionRunOutcome> {
  const { orgId } = actor;
  const conn = await db
    .execute<ProbeRow>(sql`
      select id, org_id as "orgId", source, display_name as "displayName",
             auth_kind as "authKind", status, config, secrets,
             mirror_enabled as "mirrorEnabled", mirror_schedule as "mirrorSchedule",
             posted_change_policy as "postedChangePolicy",
             posted_change_authorized_by as "postedChangeAuthorizedBy",
             posted_change_authorized_at as "postedChangeAuthorizedAt",
             cursor, last_run_at as "lastRunAt", last_error as "lastError",
             updated_at as "updatedAt"
        from connections
       where id = ${connectionId} and org_id = ${orgId}
    `)
    .then((loaded) => loaded.rows[0] ?? null)
    .catch((e) => {
      if (storageIdentityError(e)) return null;
      throw e;
    });
  if (!conn) return { status: 404, body: { errorCode: "CONNECTION_NOT_FOUND" } };
  if (conn.status === "unconfigured") return { status: 400, body: { errorCode: "CONNECTION_UNCONFIGURED" } };
  const urlError = await connectionConfigUrlRefusal(conn.config);
  if (urlError) {
    // A refused connector URL is a validation refusal on a found connection
    // (fix the connector URL and retry), never a missing connection.
    return { status: 422, body: { error: urlError, errorCode: "CONNECTOR_URL_REFUSED" } };
  }
  if (!sourceSupportsRunMode(conn.source, mode)) {
    return { status: 400, body: { errorCode: mode === "attachments" ? "ATTACHMENTS_UNSUPPORTED" : "PROJECT_FINANCIALS_UNSUPPORTED" } };
  }

  const readOnly = mode === "preflight";
  const outcome = await db.transaction(async (tx) => {
    // Match the worker's connection-wide lock. Preflight is the explicit
    // read-only exception; all other modes may rewrite shared sourceRefs.
    await tx.execute(sql`
      select pg_advisory_xact_lock(
        hashtext(${orgId}),
        hashtext(${syncConnectionRunLockKey(connectionId)})
      )`);

    const live = await tx.execute(sql`
      select id from connections
       where id = ${connectionId} and org_id = ${orgId}
         and updated_at is not distinct from ${conn.updatedAt}
         and config is not distinct from ${JSON.stringify(conn.config ?? {})}::jsonb
         and secrets is not distinct from ${conn.secrets}
       limit 1`);
    if (live.rows.length === 0) return { kind: "changed" as const };

    const queue = getMigrationQueue();
    const jobId = `migration|${connectionId}|${mode}`;
    if (!readOnly) {
      const running = await tx.execute(sql`
        select 1 from sync_runs
         where org_id = ${orgId} and connection_id = ${connectionId}
           and kind in ('incremental', 'full_migration', 'targeted_repair', 'project_financials', 'attachments')
           and status = 'running'
         limit 1`);
      if (running.rows.length > 0) return { kind: "active" as const };

      for (const queuedMode of MUTATING_MIGRATION_MODES) {
        const queued = await queue.getJob(`migration|${connectionId}|${queuedMode}`);
        if (!queued) continue;
        const state = await queued.getState();
        if (ACTIVE_MIGRATION_JOB_STATES.has(state)) return { kind: "active" as const };
        if (queuedMode === mode) {
          // The requested mode's terminal record must be removed before its
          // stable id can be deliberately reused. Other terminal records are
          // history and do not hold the connection claim.
          await queued.remove();
        }
      }
    } else {
      const existing = await queue.getJob(jobId);
      if (existing) {
        if (ACTIVE_MIGRATION_JOB_STATES.has(await existing.getState())) return { kind: "active" as const };
        await existing.remove();
      }
    }

    const job = await enqueueMigration(
      { orgId, connectionId, mode, triggeredBy: actor.userId },
      { jobId },
    );
    return { kind: "queued" as const, job };
  });
  if (outcome.kind === "changed") {
    return {
      status: 409,
      body: {
        error: "connection changed during the run; retry against the current configuration",
        errorCode: "CONNECTION_CHANGED",
      },
    };
  }
  if (outcome.kind !== "queued") return { status: 409, body: { errorCode: "RUN_ALREADY_ACTIVE" } };
  return { status: 200, body: { jobId: outcome.job.id, mode } };
}
