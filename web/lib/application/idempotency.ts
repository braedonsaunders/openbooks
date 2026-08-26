import "server-only";
import { sql } from "drizzle-orm";
import {
  db,
  orgContext,
  withOrgContext,
  withOrgTransaction,
} from "@openbooks/engine/src/db.ts";
import type { ApplicationContext } from "./context";
import { insertApiKeyEvent, markClaimedCommandEvidence } from "./api-key-audit";
import { conflict, invalidInput } from "./errors";
import {
  NonJsonValueError,
  requestHash,
  toJsonValue,
} from "./idempotency-core";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/;
const OPERATION_NAME = /^[a-z][a-z0-9_.-]{2,99}$/;

/**
 * How duplicates wait for an in-flight attempt: POLL committed state with
 * short-lived pooled reads. Blocking on the key row inside an open
 * transaction (the previous behavior) pinned one request-pool client per
 * waiter, so a burst of duplicate requests — a client retry storm, a
 * double-clicked void — occupied the entire pool and starved every other
 * endpoint until connectionTimeoutMillis gave up.
 */
const RIVAL_POLL_START_MS = 25;
const RIVAL_POLL_MAX_MS = 250;
const RIVAL_POLL_BUDGET_MS = 45_000;

type StoredKeyRow = {
  requestHash: string;
  response: unknown;
  completedAt: Date | null;
};


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read the key row from COMMITTED state without pinning anything: outside an
 * ambient tenant transaction this is an isolated pooled read (withOrgContext
 * applies the RLS GUCs per statement and releases immediately), so a waiter
 * holds no client between polls. Inside one, join it — one client total.
 */
async function readCommittedKeyRow(
  context: ApplicationContext,
  operation: string,
  idempotencyKey: string,
): Promise<StoredKeyRow | null> {
  const read = async () => {
    const result = await db.execute<StoredKeyRow>(sql`
      select request_hash as "requestHash", response, completed_at as "completedAt"
        from application_idempotency_keys
       where org_id = ${context.authz.user.orgId}
         and actor_id = ${context.authz.user.id}
         and source = ${context.source}
         and operation = ${operation}
         and idempotency_key = ${idempotencyKey}
       limit 1
    `);
    return result.rows[0] ?? null;
  };
  if (orgContext.getStore()?.txDb) return read();
  return withOrgContext(context.authz.user.orgId, read);
}

/**
 * Whether the claim advisory lock for this tuple is currently held. This is
 * the in-flight signal a committed-row read cannot provide: while the
 * claimant runs, its key row is uncommitted (invisible) AND its advisory
 * lock is held. Lock free plus row absent therefore proves the rival rolled
 * back — the command never ran durably and a waiter may claim it. Hash
 * collisions only delay a waiter until the colliding holder finishes; they
 * never let two commands run for one key (the unique index remains the
 * arbiter).
 */
async function claimLockHeld(
  context: ApplicationContext,
  operation: string,
  idempotencyKey: string,
): Promise<boolean> {
  const probe = async () => {
    const result = await db.execute<{ held: boolean }>(sql`
      select exists (
        select 1 from pg_locks
         where locktype = 'advisory'
           and classid = hashtext(${context.authz.user.orgId})::integer
           and objid = hashtext(${`${context.source}|${operation}|${idempotencyKey}`})::integer
      ) as held
    `);
    return !!result.rows[0]?.held;
  };
  if (orgContext.getStore()?.txDb) return probe();
  return withOrgContext(context.authz.user.orgId, probe);
}

/**
 * Execute one mutating command exactly once for an actor/key tuple.
 * Concurrent duplicate requests serialize on the unique index. The command
 * and stored response commit atomically; failures roll back both.
 *
 * A duplicate never holds a request-pool client while it waits: finished
 * attempts replay from a committed read, and an in-flight rival is awaited by
 * polling (with leader-failure failover — a rival that rolled back without
 * committing never ran the command, so the waiter claims it). Only the
 * claimant keeps its transaction open, across `execute()` alone.
 *
 * API-key-authenticated commands additionally commit their durable execution
 * evidence (`api_key_events`) INSIDE the claim transaction: an audit storage
 * failure rolls the whole command back, so a material effect can never exist
 * without its event. Handlers whose transport responds with a status other
 * than 200 on success must pass `successStatus` (the records adapter derives
 * it from its write result, e.g. 201 for creates).
 */
export async function executeIdempotent<T>(args: {
  context: ApplicationContext;
  operation: string;
  idempotencyKey: string;
  request: unknown;
  execute: () => Promise<T>;
  /** Maps a freshly executed command's value onto the transport status to record. */
  successStatus?: (value: T) => number;
  /** Upper bound on waiting an in-flight rival out; defaults to the standard budget. */
  rivalWaitBudgetMs?: number;
}): Promise<{ replayed: boolean; value: T }> {
  if (!OPERATION_NAME.test(args.operation)) {
    throw new Error(`invalid application operation name: ${args.operation}`);
  }
  if (!IDEMPOTENCY_KEY.test(args.idempotencyKey)) {
    throw invalidInput(
      "idempotencyKey must be 8-200 characters using letters, numbers, '.', '_', ':', or '-'",
    );
  }

  const context = args.context;
  let hash: string;
  try {
    hash = requestHash(args.request);
  } catch (error) {
    if (error instanceof NonJsonValueError) {
      throw invalidInput("request is not JSON serializable");
    }
    throw error;
  }

  const replay = (row: StoredKeyRow): { replayed: boolean; value: T } => ({
    replayed: true,
    value: row.response as T,
  });
  const assertMatchingPayload = (row: StoredKeyRow): void => {
    if (row.requestHash !== hash) {
      throw conflict("idempotencyKey was already used with different input");
    }
  };
  const isCompleted = (row: StoredKeyRow): boolean =>
    !!row.completedAt && row.response !== null;

  // Committed-state fast path: a completed attempt replays without opening
  // any transaction, and key reuse with different input fails closed before
  // touching the claim.
  const prior = await readCommittedKeyRow(context, args.operation, args.idempotencyKey);
  if (prior) {
    assertMatchingPayload(prior);
    if (isCompleted(prior)) return replay(prior);
  }

  // Claim the key and run the command. Returns undefined when a concurrent
  // attempt already owns the key; that transaction performed no writes, so
  // releasing it is free of side effects.
  //
  // The advisory try-lock is the contention gate: `insert .. on conflict do
  // nothing` alone would BLOCK on a rival's uncommitted key row — every
  // duplicate in a retry storm would sit pinned to its client until the
  // winner committed, exhausting the request pool. An uncommitted rival also
  // holds the advisory lock, so the try-lock refuses first and the loser
  // falls through to polling with no client checked out. A committed rival
  // never blocks the insert (the conflict resolves instantly against the
  // visible row). Key-space collisions merely cause a spurious poll-and-retry,
  // so correctness rests on the unique index, not on the hash.
  const claimAndExecute = (): Promise<{ replayed: boolean; value: T } | undefined> =>
    withOrgTransaction(context.authz.user.orgId, async () => {
      const gate = (await db.execute<{ acquired: boolean }>(sql`
        select pg_try_advisory_xact_lock(
                 hashtext(${context.authz.user.orgId}),
                 hashtext(${`${context.source}|${args.operation}|${args.idempotencyKey}`})
               ) as acquired
      `));
      if (!gate.rows[0]?.acquired) return undefined;

      const inserted = (await db.execute<{ id: string }>(sql`
        insert into application_idempotency_keys
          (org_id, actor_id, source, operation, idempotency_key, request_hash,
           expires_at)
        values
          (${context.authz.user.orgId}, ${context.authz.user.id}, ${context.source},
           ${args.operation}, ${args.idempotencyKey}, ${hash},
           now() + interval '30 days')
        on conflict (org_id, actor_id, source, operation, idempotency_key)
        do nothing
        returning id
      `));
      if (inserted.rows.length === 0) return undefined;

      const value = await args.execute();
      let serializable;
      try {
        serializable = toJsonValue(value);
      } catch (error) {
        if (error instanceof NonJsonValueError) {
          throw new Error("application operation returned a non-JSON value");
        }
        throw error;
      }
      await db.execute(sql`
        update application_idempotency_keys
           set response = ${JSON.stringify(serializable)}::jsonb,
               completed_at = now()
         where id = ${inserted.rows[0]!.id} and org_id = ${context.authz.user.orgId}
      `);

      // The command's durable evidence, committed atomically with it. A forced
      // audit failure throws here and rolls the entire claim back — the
      // transport then surfaces a plain internal error and no effect persists.
      const trail = context.requestAudit;
      if (context.apiKeyId && trail) {
        await insertApiKeyEvent({
          orgId: context.authz.user.orgId,
          keyId: context.apiKeyId,
          method: trail.method,
          path: trail.path,
          statusCode: args.successStatus ? args.successStatus(value) : 200,
          durationMs: Date.now() - trail.startedAt,
          ipAddress: trail.ipAddress,
          userAgent: trail.userAgent,
        });
        // Only a successfully written event claims the marker: the claim
        // transaction is about to commit (nothing after this statement fails
        // the transaction), so the transport will not write a second row.
        markClaimedCommandEvidence(trail);
      }

      return { replayed: false, value };
    });

  const claimed = await claimAndExecute();
  if (claimed) return claimed;

  // Lost the claim race: wait out the rival WITHOUT pinning a client. The
  // response and completion stamp commit atomically, so a poll either sees
  // nothing yet or the final result — never a torn state.
  const deadline = Date.now() + (args.rivalWaitBudgetMs ?? RIVAL_POLL_BUDGET_MS);
  let delay = RIVAL_POLL_START_MS;
  for (;;) {
    const row = await readCommittedKeyRow(context, args.operation, args.idempotencyKey);
    if (row) {
      assertMatchingPayload(row);
      if (isCompleted(row)) return replay(row);
    } else if (!(await claimLockHeld(context, args.operation, args.idempotencyKey))) {
      // No committed row and nobody holds the claim lock: the rival rolled
      // back without executing durably. Take over.
      const retry = await claimAndExecute();
      if (retry) return retry;
      continue;
    }
    if (Date.now() + delay >= deadline) break;
    await sleep(Math.min(delay, Math.max(1, deadline - Date.now())) * (0.5 + Math.random()));
    delay = Math.min(delay * 2, RIVAL_POLL_MAX_MS);
  }
  throw conflict("an identical operation is still in progress");
}
