import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";

/**
 * Durable exactly-once boundary for interactive bulk "Run now" executions
 * (E02). The scripts queue is attempts=1 and bulk runs are not idempotent
 * by contract, so a double-click without this claim runs the script twice
 * and double-posts. The claim lives in the shared application_idempotency_keys
 * table (no new migration): the route inserts it, the worker completes it.
 *
 * Lifecycle per client key:
 *   claimed    — this caller owns the run; enqueue (or run inline) now.
 *   inflight   — a rival owns it; the route answers 409 instead of running.
 *   completed  — the run finished; the stored response is replayed, nothing
 *                runs again. The worker also checks this before running, so
 *                a redelivered or ambiguous-enqueue duplicate reconciles
 *                onto the recorded outcome instead of executing twice.
 *
 * Residual: a route-inline run racing a queued job under a total Redis
 * outage can still execute concurrently (no ownership column exists to tell
 * the rivals apart). The deterministic queue id makes that window require
 * Redis to accept the job AND lose the reply AND be unreachable for the
 * probe; the completed-check bounds every sequential case.
 */

export const BULK_RUN_OPERATION = "script.bulk.run";
export const BULK_RUN_SOURCE = "api";

const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;

/** Require the caller's stable run key and validate it before claiming. */
export function bulkRunClientKey(provided: unknown): string {
  if (typeof provided !== "string" || !KEY_PATTERN.test(provided)) {
    throw new Error("script run idempotency key is required and must be 8-200 letters, digits, dot, underscore, colon, dash");
  }
  return provided;
}

/** Deterministic queue identity for one bulk-run intent. */
export function bulkScriptQueueJobId(scriptId: string, key: string): string {
  // BullMQ reserves colon as its internal key separator. Hash the caller key
  // into a deterministic, separator-safe job id while retaining the full key
  // in the durable database claim.
  const keyDigest = createHash("sha256").update(key).digest("hex");
  return `script-bulk|${scriptId}|${keyDigest}`;
}

function requestHash(scriptId: string): string {
  return createHash("sha256").update(`openbooks.script-bulk-run.v1\0${scriptId}`).digest("hex");
}

export type BulkRunClaim =
  | { status: "claimed" }
  | { status: "inflight" }
  | { status: "completed"; response: unknown }
  | { status: "mismatched" };

/**
 * Insert the run claim, or reconcile against the rival's row. Insert and
 * conflicting insert serialize on the identity unique index, so exactly one
 * caller ever sees "claimed".
 */
export async function claimBulkRunKey(args: {
  orgId: string;
  actorId: string;
  scriptId: string;
  key: string;
}): Promise<BulkRunClaim> {
  const hash = requestHash(args.scriptId);
  const inserted = (await db.execute<{ id: string }>(sql`
    insert into application_idempotency_keys
      (org_id, actor_id, source, operation, idempotency_key, request_hash)
    values (${args.orgId}, ${args.actorId}, ${BULK_RUN_SOURCE}, ${BULK_RUN_OPERATION}, ${args.key}, ${hash})
    on conflict (org_id, actor_id, source, operation, idempotency_key) do nothing
    returning id
  `));
  if (inserted.rows[0]) return { status: "claimed" };
  const rival = (await db.execute<{ requestHash: string; response: unknown; completedAt: Date | null }>(sql`
    select request_hash as "requestHash", response, completed_at as "completedAt"
      from application_idempotency_keys
     where org_id = ${args.orgId} and actor_id = ${args.actorId}
       and source = ${BULK_RUN_SOURCE} and operation = ${BULK_RUN_OPERATION}
       and idempotency_key = ${args.key}
  `)).rows[0];
  if (!rival) return { status: "claimed" };
  if (rival.requestHash !== hash) return { status: "mismatched" };
  if (rival.completedAt !== null) return { status: "completed", response: rival.response };
  return { status: "inflight" };
}

/**
 * Stable journal idempotency scope for one bulk-run intent. A stall
 * redelivery of the same claim reuses this scope, so its journal writes
 * replay the first execution's documents instead of double-posting (E02).
 * Distinct keys stay distinct; unkeyed launches never reach here.
 */
export function bulkRunIdempotencyScope(key: string): string {
  return `key/${key}`;
}

/**
 * A marker left too long ago to belong to a live execution. Bulk runs are
 * fenced by a 30 s budget, so a start marker older than this horizon is a
 * crashed owner, not a slow one — a later delivery may take over and replay
 * under the stable scope. Short enough to bound crash recovery, long past
 * any legitimate run.
 */
export const BULK_RUN_EXECUTION_TAKEOVER_MS = 5 * 60_000;

export type BulkRunExecution =
  | { status: "mine" }
  | { status: "completed"; response: unknown }
  | { status: "inflight" }
  | { status: "mismatched" };

/**
 * Atomically elect one executor for a claimed bulk run (E02). The winner
 * stamps a start marker and runs; a rival delivery that finds a fresh marker
 * — a BullMQ stall redelivery racing the live first execution — must NOT
 * re-execute, it refuses loudly instead. A stale marker is a crashed owner:
 * the takeover reuses the stable scope, so it replays instead of
 * double-posting. Completed claims replay the recorded response; a key bound
 * to another script refuses before any source runs.
 */
export async function claimBulkRunExecution(args: {
  orgId: string;
  actorId: string;
  scriptId: string;
  key: string;
}): Promise<BulkRunExecution> {
  const hash = requestHash(args.scriptId);
  const startedAt = new Date().toISOString();
  const cutoff = new Date(Date.now() - BULK_RUN_EXECUTION_TAKEOVER_MS).toISOString();
  // One statement elects: exactly one rival wins the row lock. ISO-8601
  // markers compare lexicographically; coalesce keeps a non-marker response
  // takeover-eligible instead of throwing on the cast.
  const won = (await db.execute<{ id: string }>(sql`
    update application_idempotency_keys
       set response = ${JSON.stringify({ bulkRunStartedAt: startedAt })}::jsonb
     where org_id = ${args.orgId} and actor_id = ${args.actorId}
       and source = ${BULK_RUN_SOURCE} and operation = ${BULK_RUN_OPERATION}
       and idempotency_key = ${args.key}
       and request_hash = ${hash}
       and completed_at is null
       and (response is null or coalesce(response->>'bulkRunStartedAt', '') < ${cutoff})
    returning id
  `));
  if (won.rows[0]) return { status: "mine" };
  const rival = (await db.execute<{ requestHash: string; response: unknown; completedAt: Date | null }>(sql`
    select request_hash as "requestHash", response, completed_at as "completedAt"
      from application_idempotency_keys
     where org_id = ${args.orgId} and actor_id = ${args.actorId}
       and source = ${BULK_RUN_SOURCE} and operation = ${BULK_RUN_OPERATION}
       and idempotency_key = ${args.key}
  `)).rows[0];
  if (!rival) return { status: "mine" };
  if (rival.requestHash !== hash) return { status: "mismatched" };
  if (rival.completedAt !== null) return { status: "completed", response: rival.response };
  return { status: "inflight" };
}

/** Read a claim without owning it (the worker's pre-run check). */
export async function readBulkRunClaim(args: {
  orgId: string;
  actorId: string;
  scriptId: string;
  key: string;
}): Promise<BulkRunClaim> {
  const hash = requestHash(args.scriptId);
  const row = (await db.execute<{ requestHash: string; response: unknown; completedAt: Date | null }>(sql`
    select request_hash as "requestHash", response, completed_at as "completedAt"
      from application_idempotency_keys
     where org_id = ${args.orgId} and actor_id = ${args.actorId}
       and source = ${BULK_RUN_SOURCE} and operation = ${BULK_RUN_OPERATION}
       and idempotency_key = ${args.key}
  `)).rows[0];
  if (!row) return { status: "claimed" };
  if (row.requestHash !== hash) return { status: "mismatched" };
  if (row.completedAt !== null) return { status: "completed", response: row.response };
  return { status: "inflight" };
}

/**
 * Record the run outcome exactly once: only an in-flight claim completes,
 * so a replayed completion can never overwrite the recorded response.
 * Returns true when this call completed the claim.
 */
export async function completeBulkRunKey(args: {
  orgId: string;
  actorId: string;
  scriptId: string;
  key: string;
  response: unknown;
}): Promise<boolean> {
  // Script return values ride along in the outcome: never let an
  // unserializable one (BigInt, cycles) fail the durable write and strand
  // the claim in-flight forever.
  let stored: unknown;
  try {
    stored = JSON.parse(JSON.stringify(args.response) ?? "null");
  } catch {
    stored = { unserializableResponse: String(args.response).slice(0, 200) };
  }
  const updated = (await db.execute<{ id: string }>(sql`
    update application_idempotency_keys
       set response = ${JSON.stringify(stored)}::jsonb,
           completed_at = coalesce(completed_at, now())
     where org_id = ${args.orgId} and actor_id = ${args.actorId}
       and source = ${BULK_RUN_SOURCE} and operation = ${BULK_RUN_OPERATION}
       and idempotency_key = ${args.key}
       and request_hash = ${requestHash(args.scriptId)}
       and completed_at is null
    returning id
  `));
  return (updated.rows?.length ?? 0) > 0;
}
