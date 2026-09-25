import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { enqueueMigration, getMigrationQueue } from "@openbooks/jobs";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { syncConnectionRunLockKey } from "@openbooks/engine/src/sync/sync.ts";
import type { ConnectionRow } from "@openbooks/engine/src/sync/connection.ts";
import { guardPermission, guardUnrestrictedScope } from "../../../../../../lib/authz";
import { storageIdentityError } from "../../_storage-identity";
import { connectionConfigUrlRefusal } from "../../_connector-guard";

export const runtime = "nodejs";

type ProbeRow = ConnectionRow & { updatedAt: Date | string | null };

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

/**
 * Enqueue a migration or mirror pass for this connection onto the worker.
 * Returns immediately with the job id; progress lands in the sync_runs table
 * the platform page renders. One job per (connection, mode) is de-duped so a
 * double click can't launch two backfills.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  const scopeDenied = guardUnrestrictedScope(gate);
  if (scopeDenied) return scopeDenied;
  const orgId = gate.user.orgId;
  const { id } = await params;
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
       where id = ${id} and org_id = ${orgId}
    `)
    .then((loaded) => loaded.rows[0] ?? null)
    .catch((e) => {
      if (storageIdentityError(e)) return null;
      throw e;
    });
  if (!conn)
    return NextResponse.json(
      { errorCode: "CONNECTION_NOT_FOUND" },
      { status: 404 },
    );
  if (conn.status === "unconfigured") {
    return NextResponse.json(
      { errorCode: "CONNECTION_UNCONFIGURED" },
      { status: 400 },
    );
  }
  const urlError = await connectionConfigUrlRefusal(conn.config);
  if (urlError) {
    // A refused connector URL is a validation refusal on a found connection
    // (fix the connector URL and retry), never a missing connection.
    return NextResponse.json(
      { error: urlError, errorCode: "CONNECTOR_URL_REFUSED" },
      { status: 422 },
    );
  }

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    mode?:
      | "full_migration"
      | "preflight"
      | "mirror"
      | "project_financials"
      | "attachments";
  };
  if (
    !body.mode ||
    ![
      "full_migration",
      "preflight",
      "mirror",
      "project_financials",
      "attachments",
    ].includes(body.mode)
  ) {
    return NextResponse.json({ errorCode: "INVALID_MODE" }, { status: 400 });
  }
  if (body.mode === "attachments" && conn.source !== "netsuite") {
    return NextResponse.json(
      { errorCode: "ATTACHMENTS_UNSUPPORTED" },
      { status: 400 },
    );
  }
  if (body.mode === "project_financials" && conn.source !== "netsuite") {
    return NextResponse.json(
      { errorCode: "PROJECT_FINANCIALS_UNSUPPORTED" },
      { status: 400 },
    );
  }
  const mode = body.mode;

  const readOnly = mode === "preflight";
  const outcome = await db.transaction(async (tx) => {
    // Match the worker's connection-wide lock. Preflight is the explicit
    // read-only exception; all other modes may rewrite shared sourceRefs.
    await tx.execute(sql`
      select pg_advisory_xact_lock(
        hashtext(${orgId}),
        hashtext(${syncConnectionRunLockKey(id)})
      )`);

    const live = await tx.execute(sql`
      select id from connections
       where id = ${id} and org_id = ${orgId}
         and updated_at is not distinct from ${conn.updatedAt}
         and config is not distinct from ${JSON.stringify(conn.config ?? {})}::jsonb
         and secrets is not distinct from ${conn.secrets}
       limit 1`);
    if (live.rows.length === 0) return { kind: "changed" as const };

    const queue = getMigrationQueue();
    const jobId = `migration|${id}|${mode}`;
    if (!readOnly) {
      const running = await tx.execute(sql`
        select 1 from sync_runs
         where org_id = ${orgId} and connection_id = ${id}
           and kind in ('incremental', 'full_migration', 'targeted_repair', 'project_financials', 'attachments')
           and status = 'running'
         limit 1`);
      if (running.rows.length > 0) return { kind: "active" as const };

      for (const queuedMode of MUTATING_MIGRATION_MODES) {
        const queued = await queue.getJob(`migration|${id}|${queuedMode}`);
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
      { orgId, connectionId: id, mode, triggeredBy: gate.user.id },
      { jobId },
    );
    return { kind: "queued" as const, job };
  });
  if (outcome.kind === "changed") {
    return NextResponse.json(
      {
        error:
          "connection changed during the run; retry against the current configuration",
        errorCode: "CONNECTION_CHANGED",
      },
      { status: 409 },
    );
  }
  if (outcome.kind !== "queued") {
    return NextResponse.json(
      { errorCode: "RUN_ALREADY_ACTIVE" },
      { status: 409 },
    );
  }
  return NextResponse.json({ jobId: outcome.job.id, mode });
}
