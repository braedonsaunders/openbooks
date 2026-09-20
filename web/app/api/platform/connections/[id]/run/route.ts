import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { enqueueMigration, getMigrationQueue } from "@openbooks/jobs";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { getConnection } from "@openbooks/engine/src/sync/connection.ts";
import { guardPermission } from "../../../../../../lib/authz";
import { storageIdentityError } from "../../_storage-identity";

export const runtime = "nodejs";

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
  const conn = await getConnection(orgId, id).catch((e) => {
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
  const urlError = connectionConfigUrlRefusal(conn.config);
  if (urlError) {
    return NextResponse.json(
      { error: urlError, errorCode: "CONNECTOR_URL_REFUSED" },
      { status: 404 },
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
