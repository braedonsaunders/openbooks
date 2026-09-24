import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { enqueueMigration, getMigrationQueue } from "@openbooks/jobs";
import { db } from "@openbooks/engine/src/platform/db.ts";
import type { ConnectionRow } from "@openbooks/engine/src/sync/connection.ts";
import { guardPermission } from "../../../../../../lib/authz";
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

  const runKind =
    mode === "mirror"
      ? "incremental"
      : mode === "preflight"
        ? "full_preflight"
        : mode;
  const outcome = await db.transaction(async (tx) => {
    // The worker creates the sync_runs row after it starts consuming the job.
    // Serialize the database check and queue claim so concurrent requests cannot
    // both pass the pre-worker window. The stable job id closes that same window
    // across replicas, where the transaction lock cannot cover Redis alone.
    await tx.execute(sql`
      select pg_advisory_xact_lock(
        hashtext(${orgId}),
        hashtext(${`connection-run:${id}:${mode}`})
      )`);

    const live = await tx.execute(sql`
      select id from connections
       where id = ${id} and org_id = ${orgId}
         and updated_at is not distinct from ${conn.updatedAt}
         and config is not distinct from ${JSON.stringify(conn.config ?? {})}::jsonb
         and secrets is not distinct from ${conn.secrets}
       limit 1`);
    if (live.rows.length === 0) return { kind: "changed" as const };

    const running = await tx.execute(sql`
      select 1 from sync_runs
       where org_id = ${orgId} and connection_id = ${id}
         and kind = ${runKind} and status = 'running'
       limit 1`);
    if (running.rows.length > 0) return { kind: "active" as const };

    const queue = getMigrationQueue();
    const jobId = `migration|${id}|${mode}`;
    const existing = await queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (ACTIVE_MIGRATION_JOB_STATES.has(state)) return { kind: "active" as const };
      // Completed/failed jobs are retained by the queue for operational
      // history. Remove the terminal record before reusing its stable id for a
      // deliberate later run; active and waiting records returned above remain
      // the one authoritative request for this connection/mode.
      await existing.remove();
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
