import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { enqueueMigration, getMigrationQueue } from "@openbooks/jobs";
import { db } from "@openbooks/engine/src/db.ts";
import { getConnection } from "@openbooks/engine/src/sync/connection.ts";
import { guardPermission } from "../../../../../../lib/authz";

export const runtime = "nodejs";

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

  const conn = await getConnection(orgId, id);
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
  const job = await db.transaction(async (tx) => {
    // The worker creates the sync_runs row after it starts consuming the job.
    // Serialize the database check and queue claim so concurrent requests cannot
    // both pass the pre-worker window. The stable job id closes that same window
    // across replicas, where the transaction lock cannot cover Redis alone.
    await tx.execute(sql`
      select pg_advisory_xact_lock(
        hashtext(${orgId}),
        hashtext(${`connection-run:${id}:${mode}`})
      )`);

    const running = await tx.execute(sql`
      select 1 from sync_runs
       where org_id = ${orgId} and connection_id = ${id}
         and kind = ${runKind} and status = 'running'
       limit 1`);
    if (running.rows.length > 0) return null;

    const queue = getMigrationQueue();
    const jobId = `migration|${id}|${mode}`;
    const existing = await queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (ACTIVE_MIGRATION_JOB_STATES.has(state)) return null;
      // Completed/failed jobs are retained by the queue for operational
      // history. Remove the terminal record before reusing its stable id for a
      // deliberate later run; active and waiting records returned above remain
      // the one authoritative request for this connection/mode.
      await existing.remove();
    }

    return enqueueMigration(
      { orgId, connectionId: id, mode, triggeredBy: gate.user.id },
      { jobId },
    );
  });
  if (!job) {
    return NextResponse.json(
      { errorCode: "RUN_ALREADY_ACTIVE" },
      { status: 409 },
    );
  }
  return NextResponse.json({ jobId: job.id, mode });
}
