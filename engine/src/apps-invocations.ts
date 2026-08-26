import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "./db.ts";
import { canonicalJson } from "./canonical-json.ts";

/**
 * Invocation-exactly-once envelope for App backend execution.
 *
 * A sandboxed App endpoint (and every App platform bridge mutation) is ONE
 * logical invocation that must either commit ALL of its material effects
 * together with its audit evidence or leave ZERO durable effects. Before this
 * envelope existed, ob.journal.create and platform CRUD committed through
 * their own adapters while the app_runs evidence row was written best-effort
 * afterwards — a handler could post a journal and then throw/timeout, the
 * caller saw an error, a retry duplicated the posting, and an app_runs
 * outage stripped the effects of their provenance.
 *
 * Contract enforced here:
 *
 *   (a) An idempotency key (source 'app' in application_idempotency_keys) is
 *       CLAIMED before `run()` executes any statement. The key's request hash
 *       pins it to one input; reuse with different input fails closed.
 *   (b) The attempt runs inside `withOrgTransaction` on a SAVEPOINT: a success
 *       releases the savepoint, marks the claim completed WITH its stored
 *       response, and writes the audit row — all committing atomically.
 *       Failures roll the savepoint back, so nothing the handler did survives.
 *   (c) A failed attempt keeps its claim row but leaves it UNCOMPLETED
 *       (schema guard makes this evidence append-only). An uncompleted claim
 *       proves nothing ran durably, so a retry after a throw/timeout takes
 *       the same claim over with no duplicate effects to fear; because a
 *       completed claim carries the stored response, a retry after a lost
 *       HTTP result (process crash between commit and response) replays the
 *       first outcome instead of duplicating the work.
 *   (d) Audit failure is load-bearing: the audit write happens inside the same
 *       transaction, so if it cannot be persisted the whole invocation — claim,
 *       effects, everything — rolls back and the error propagates. Evidence can
 *       no longer be silently suppressed after material effects commit.
 *   (e) Concurrent duplicates of one key are refused (advisory try-lock +
 *       unique index arbiter): the loser fails closed with 409 semantics
 *       rather than pinning pool clients waiting for the winner. Sequential
 *       replays of a COMPLETED invocation serve the stored response.
 *
 * The runtime NEVER bypasses RLS inside this unit: withOrgTransaction applies
 * the tenant GUCs transaction-locally, and every adapter query issued by the
 * sandbox rides the same pinned connection through the db proxy, which is what
 * makes "all-or-nothing" physically true for multi-write handlers.
 */

/** Terminal outcome of one attempt. `run()` implementations return these; only
 * genuine infrastructure faults should ever REJECT out of run(). */
export interface AppInvocationAttempt {
  status: "ok" | "error" | "timeout" | "forbidden";
  /** Present when ok; this exact value commits as the replayable response. */
  response?: unknown;
  error?: string | null;
  logs?: string[];
  units?: number;
  durationMs?: number;
}

export type AppInvocationAuditRow = {
  orgId: string;
  appId: string;
  versionId: string | null;
  endpoint: string;
  actorId: string;
  status: AppInvocationAttempt["status"];
  errorMessage: string | null;
  logs: string[];
  units: number;
  durationMs: number;
};

export class AppInvocationInFlightError extends Error {
  readonly name = "AppInvocationInFlightError";
  constructor(operation: string) {
    super(`an identical ${operation} invocation is already in progress`);
  }
}

export class AppInvocationRequestMismatchError extends Error {
  readonly name = "AppInvocationRequestMismatchError";
  constructor() {
    super("idempotency key was already used with different input");
  }
}

class AppInvocationClaimShapeError extends Error {
  readonly name = "AppInvocationClaimShapeError";
}

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,200}$/;
// Mirrors application_idempotency_operation_format in the schema.
const OPERATION_RE = /^apps\.[a-z][a-z0-9_.-]{2,94}$/;
const REQUEST_HASH_RE = /^[0-9a-f]{64}$/;
/** Hash domain separator so App keys can never collide across operation kinds. */
const KEY_NAMESPACE = "app-invocation";

/**
 * Derive the deterministic identity of one App invocation: sha256 over its
 * canonical parts (app/version/endpoint/payload). Server-side derivation means
 * byte-identical repeat requests collapse onto the first committed outcome —
 * the standard consequence of key derivation absent a client-supplied key —
 * while any changed input yields a fresh independent invocation.
 */
export function deriveAppInvocationKey(parts: Record<string, unknown>): string {
  const digest = createHash("sha256")
    .update(KEY_NAMESPACE)
    .update("\n")
    .update(canonicalJson(parts))
    .digest("hex");
  return digest;
}

interface ClaimRow {
  id: string;
  requestHash: string;
  response: unknown;
  completedAt: Date | null;
}

async function readCommittedClaim(
  orgId: string,
  actorId: string,
  operation: string,
  idempotencyKey: string,
): Promise<ClaimRow | null> {
  const r = await db.execute<{
    id: string;
    requestHash: string;
    response: unknown;
    completedAt: Date | null;
  }>(sql`
    select id, request_hash as "requestHash", response, completed_at as "completedAt"
      from application_idempotency_keys
     where org_id = ${orgId} and actor_id = ${actorId} and source = 'app'
       and operation = ${operation} and idempotency_key = ${idempotencyKey}
     limit 1`);
  const row = r.rows[0];
  return row
    ? {
        id: String(row.id),
        requestHash: String(row.requestHash),
        response: row.response,
        completedAt: row.completedAt,
      }
    : null;
}

function assertSameRequest(row: ClaimRow, requestHash: string): void {
  if (row.requestHash !== requestHash) {
    throw new AppInvocationRequestMismatchError();
  }
}

export async function executeAppInvocation(args: {
  orgId: string;
  actorId: string;
  appId: string;
  versionId: string | null;
  /** Human-facing surface name recorded in the audit row (e.g. callBackend/<endpoint>). */
  endpoint: string;
  /** Registry operation, lowercase `apps.<kind>…` (validated against the DB format). */
  operation: string;
  idempotencyKey: string;
  requestHash: string;
  /** The attempt. MUST issue all of its statements through `db` so they join
   * the envelope's pinned tenant transaction. Must not reject except for
   * infrastructure faults. */
  run: () => Promise<AppInvocationAttempt>;
  /** Persist exactly one audit row for this attempt; MUST use `db` so the
   * insert joins the same transaction (fail-closed). */
  audit: (row: AppInvocationAuditRow) => Promise<void>;
}): Promise<{ attempt: AppInvocationAttempt; replayed: boolean }> {
  const { orgId, actorId } = args;
  if (!OPERATION_RE.test(args.operation)) {
    throw new AppInvocationClaimShapeError(`invalid app invocation operation: ${args.operation}`);
  }
  if (!IDEMPOTENCY_KEY_RE.test(args.idempotencyKey)) {
    throw new AppInvocationClaimShapeError("invalid app invocation idempotency key");
  }
  if (!REQUEST_HASH_RE.test(args.requestHash)) {
    throw new AppInvocationClaimShapeError("invalid app invocation request hash");
  }

  // One transaction IS the atomic unit; it also serializes concurrent
  // duplicates of the same key via a tenant-scoped advisory try-lock so a
  // loser can neither block a pooled client nor double-run.
  return withOrgTransaction(orgId, async () => {
    const gateName = `${args.operation}|${args.idempotencyKey}|${actorId}`;
    const gate = await db.execute<{ acquired: boolean }>(sql`
      select pg_try_advisory_xact_lock(hashtextextended(${gateName}, 0)) as acquired`);
    if (!gate.rows[0]?.acquired) throw new AppInvocationInFlightError(args.operation);

    const prior = await readCommittedClaim(orgId, actorId, args.operation, args.idempotencyKey);
    if (prior?.completedAt != null) {
      // A COMPLETED claim carries the stored response: retries after a lost
      // HTTP result replay it instead of re-executing the work. Uncompleted
      // claims (prior failed attempts) fall through and are taken over below
      // — they prove nothing ran durably, so a retry is safe.
      assertSameRequest(prior, args.requestHash);
      await args.audit({
        orgId,
        appId: args.appId,
        versionId: args.versionId,
        endpoint: args.endpoint,
        actorId,
        status: "ok",
        errorMessage: null,
        logs: ["replayed: served the stored response of the earlier identical invocation"],
        units: 0,
        durationMs: 0,
      });
      return { attempt: { status: "ok", response: prior.response }, replayed: true };
    }
    if (prior) {
      // Uncompleted claim from a prior failed attempt — the retry takes it
      // over, but only for identical input (a claim binds its request hash).
      assertSameRequest(prior, args.requestHash);
    }

    const inserted = await db.execute<{ id: string }>(sql`
      insert into application_idempotency_keys
        (org_id, actor_id, source, operation, idempotency_key, request_hash, expires_at)
      values (${orgId}, ${actorId}, 'app', ${args.operation}, ${args.idempotencyKey},
              ${args.requestHash}, now() + interval '30 days')
      on conflict (org_id, actor_id, source, operation, idempotency_key) do nothing
      returning id`);
    const claimId = inserted.rows[0]?.id ?? prior?.id;
    if (!claimId) {
      // Only reachable under an advisory-key collision with a rival that ran
      // without our lock namespace: fail closed rather than guess.
      throw new AppInvocationInFlightError(args.operation);
    }

    await db.execute(sql`savepoint app_invocation_attempt`);
    let attempt: AppInvocationAttempt;
    try {
      attempt = await args.run();
    } catch (error) {
      // Infrastructure fault inside the handler. Recover the transaction so
      // refusal evidence stays recordable; if even THAT fails the whole unit
      // rolls back and the fault propagates — never partially silent.
      attempt = {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        logs: [],
        units: 0,
        durationMs: 0,
      };
      await db.execute(sql`rollback to savepoint app_invocation_attempt`);
      await args.audit({
        orgId,
        appId: args.appId,
        versionId: args.versionId,
        endpoint: args.endpoint,
        actorId,
        status: "error",
        errorMessage: attempt.error ?? null,
        logs: [],
        units: 0,
        durationMs: 0,
      });
      return { attempt, replayed: false };
    }

    const auditBase = {
      orgId,
      appId: args.appId,
      versionId: args.versionId,
      endpoint: args.endpoint,
      actorId,
    };

    if (attempt.status !== "ok") {
      // Refused/sandbox-failed attempt: undo everything the handler staged
      // (including platform/journal/KV writes). The claim row STAYS as an
      // uncompleted failed-attempt record — the schema keeps this evidence
      // append-only, an uncompleted claim proves zero durable effects, and
      // (c) holds: retrying this identity later takes the same claim over
      // with no duplicate effects to fear.
      await db.execute(sql`rollback to savepoint app_invocation_attempt`);
      await args.audit({
        ...auditBase,
        status: attempt.status,
        errorMessage: attempt.error ?? null,
        logs: attempt.logs ?? [],
        units: attempt.units ?? 0,
        durationMs: attempt.durationMs ?? 0,
      });
      return { attempt, replayed: false };
    }

    await db.execute(sql`release savepoint app_invocation_attempt`);
    await db.execute(sql`
      update application_idempotency_keys
         set response = ${JSON.stringify(attempt.response ?? null)}::jsonb, completed_at = now()
       where id = ${claimId}`);
    await args.audit({
      ...auditBase,
      status: "ok",
      errorMessage: null,
      logs: attempt.logs ?? [],
      units: attempt.units ?? 0,
      durationMs: attempt.durationMs ?? 0,
    });
    return { attempt, replayed: false };
  });
}
