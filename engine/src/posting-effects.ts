import { sql } from "drizzle-orm";
import { db, type SqlExecutor, withBypassContext } from "./db.ts";
import {
  logTerminalFailure,
  POSTING_EFFECTS_WORKER_IDENTITY,
} from "./terminal-failure.ts";
import {
  ATTR_KIND,
  ATTR_ORG_ID,
  ATTR_ROW_ID,
  ATTR_SURFACE,
  recordOutboxAttempt,
  runInSpan,
} from "./telemetry.ts";

/**
 * Durable posting-effects outbox. The journal commits before these downstream
 * projections run, so every attempt, terminal failure, and operator replay is
 * durable and auditable. Retryable failures use `failed`; poison work makes an
 * explicit one-way transition to `terminal_failed` at the attempt ceiling.
 */

export const MAX_POSTING_EFFECTS_ATTEMPTS = 8;
export const STALE_POSTING_EFFECTS_MS = 15 * 60_000;

export type PostingEffectsRow = {
  id: string;
  org_id: string;
  document_id: string;
  kind: string;
  entry_id: string;
  posting_date: string;
  actor_id: string | null;
  attempt_count: number;
};

export class PostingEffectsTerminalFailureError extends Error {
  constructor(documentId: string) {
    super(`posting effects for document ${documentId} require operator remediation`);
    this.name = "PostingEffectsTerminalFailureError";
  }
}

export class PostingEffectsReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostingEffectsReplayError";
  }
}

type TerminalizedPostingEffectsRow = PostingEffectsRow & {
  terminal_failure_reason: string;
  terminal_failed_at: Date | string;
  terminal_failed_by: string;
  becameTerminal: boolean;
};

export function postingEffectsBackoffMs(attemptCount: number): number {
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attemptCount - 1));
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

async function insertTerminalFailureAudit(
  tx: SqlExecutor,
  row: TerminalizedPostingEffectsRow,
): Promise<void> {
  await tx.execute(sql`
    insert into audit_log
      (org_id, table_name, row_id, action, changes, actor_id, request_id, at)
    values (
      ${row.org_id}, 'posting_effects', ${row.id}, 'update',
      ${JSON.stringify({
        event: "posting_effects_terminal_failure",
        before: { status: "running", attemptCount: row.attempt_count },
        after: {
          status: "terminal_failed",
          attemptCount: row.attempt_count,
          reason: row.terminal_failure_reason,
          terminalFailedAt: row.terminal_failed_at,
          terminalFailedBy: row.terminal_failed_by,
        },
        documentId: row.document_id,
        kind: row.kind,
      })}::jsonb,
      null, 'posting_effects_terminal_failure', ${row.terminal_failed_at}
    )
  `);
}

function emitTerminalFailure(row: TerminalizedPostingEffectsRow): void {
  logTerminalFailure({
    surface: "posting_effects",
    kind: row.kind,
    id: row.id,
    orgId: row.org_id,
    subjectId: row.document_id,
    attempts: row.attempt_count,
    error: row.terminal_failure_reason,
    markedBy: row.terminal_failed_by,
    at: row.terminal_failed_at instanceof Date
      ? row.terminal_failed_at
      : new Date(row.terminal_failed_at),
  });
}

/** Insert inside the posting transaction so a crash after commit still has a row. */
export async function enqueuePostingEffects(
  tx: SqlExecutor,
  input: {
    orgId: string;
    documentId: string;
    kind: string;
    entryId: string;
    postingDate: string;
    actorId: string | null;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into posting_effects
      (org_id, document_id, kind, entry_id, posting_date, actor_id, status)
    values (
      ${input.orgId}, ${input.documentId}, ${input.kind}, ${input.entryId},
      ${input.postingDate}, ${input.actorId}, 'pending'
    )
    on conflict (document_id) do nothing
  `);
}

/** Recover crash-orphaned work. An at-ceiling claim becomes terminal in the
 * same transaction that writes its append-only audit evidence. */
export async function recoverStalePostingEffects(now = new Date()): Promise<number> {
  const staleReason = "posting-effects lease expired after the worker stopped reporting";
  const recovered = await db.transaction(async (tx) => {
    const result = await tx.execute<TerminalizedPostingEffectsRow>(sql`
      update posting_effects
         set status=case when attempt_count >= ${MAX_POSTING_EFFECTS_ATTEMPTS}
                         then 'terminal_failed' else 'failed' end,
             error=${staleReason},
             locked_at=null,
             finished_at=${now},
             next_attempt_at=${now},
             terminal_failure_reason = case
               when attempt_count >= ${MAX_POSTING_EFFECTS_ATTEMPTS}
               then ${staleReason} else terminal_failure_reason end,
             terminal_failed_at = case
               when attempt_count >= ${MAX_POSTING_EFFECTS_ATTEMPTS}
               then coalesce(terminal_failed_at, ${now}) else terminal_failed_at end,
             terminal_failed_by = case
               when attempt_count >= ${MAX_POSTING_EFFECTS_ATTEMPTS}
                    and terminal_failed_at is null
               then ${POSTING_EFFECTS_WORKER_IDENTITY} else terminal_failed_by end,
             updated_at=now()
       where status='running'
         and locked_at is not null
         and locked_at < ${new Date(now.getTime() - STALE_POSTING_EFFECTS_MS)}
       returning id, org_id, document_id, kind, entry_id,
                 posting_date::text as posting_date, actor_id, attempt_count,
                 terminal_failure_reason, terminal_failed_at, terminal_failed_by,
                 (attempt_count >= ${MAX_POSTING_EFFECTS_ATTEMPTS}
                  and terminal_failed_by = ${POSTING_EFFECTS_WORKER_IDENTITY}
                  and terminal_failed_at = ${now}) as "becameTerminal"
    `);
    for (const row of result.rows) {
      if (row.becameTerminal) await insertTerminalFailureAudit(tx, row);
    }
    return result;
  });
  for (const row of recovered.rows) {
    if (row.becameTerminal) emitTerminalFailure(row);
  }
  return recovered.rowCount ?? 0;
}

/** Claim one posted document for the synchronous happy-path drain. */
export async function claimPostingEffectsForDocument(
  documentId: string,
  now = new Date(),
): Promise<PostingEffectsRow | "succeeded" | "running" | "terminal_failed" | null> {
  const claimed = await db.execute<PostingEffectsRow>(sql`
    update posting_effects as claimed
       set status='running',
           attempt_count=attempt_count+1,
           locked_at=${now},
           last_attempt_at=${now},
           finished_at=null,
           error=null,
           updated_at=now()
     where claimed.document_id = ${documentId}
       and claimed.status in ('pending','failed')
       and claimed.attempt_count < ${MAX_POSTING_EFFECTS_ATTEMPTS}
     returning claimed.id, claimed.org_id, claimed.document_id, claimed.kind, claimed.entry_id,
               claimed.posting_date::text as posting_date, claimed.actor_id, claimed.attempt_count
  `);
  if (claimed.rows[0]) return claimed.rows[0];
  const existing = await db.execute<{ status: string }>(sql`
    select status from posting_effects where document_id = ${documentId}
  `);
  const status = existing.rows[0]?.status;
  if (status === "succeeded") return "succeeded";
  if (status === "running" || status === "failed") return "running";
  if (status === "terminal_failed") return "terminal_failed";
  return null;
}

async function claimNextDuePostingEffects(now: Date): Promise<PostingEffectsRow | null> {
  const claimed = await db.execute<PostingEffectsRow>(sql`
    update posting_effects as claimed
       set status='running',
           attempt_count=attempt_count+1,
           locked_at=${now},
           last_attempt_at=${now},
           finished_at=null,
           error=null,
           updated_at=now()
      from (
        select id from posting_effects
         where status in ('pending','failed')
           and attempt_count < ${MAX_POSTING_EFFECTS_ATTEMPTS}
           and next_attempt_at <= ${now}
         order by next_attempt_at
         for update skip locked
         limit 1
      ) as due
     where claimed.id = due.id
     returning claimed.id, claimed.org_id, claimed.document_id, claimed.kind, claimed.entry_id,
               claimed.posting_date::text as posting_date, claimed.actor_id, claimed.attempt_count
  `);
  return claimed.rows[0] ?? null;
}

export async function markPostingEffectsSucceeded(
  row: PostingEffectsRow,
  now = new Date(),
): Promise<void> {
  await db.execute(sql`
    update posting_effects
       set status='succeeded', error=null, locked_at=null, finished_at=${now},
           next_attempt_at=${now}, updated_at=now()
     where id=${row.id} and status='running'
  `);
}

export async function markPostingEffectsFailed(
  row: PostingEffectsRow,
  error: unknown,
  now = new Date(),
): Promise<void> {
  const message = errorMessage(error);
  const terminal = row.attempt_count >= MAX_POSTING_EFFECTS_ATTEMPTS;
  const marked = await db.transaction(async (tx) => {
    const result = await tx.execute<TerminalizedPostingEffectsRow>(sql`
      update posting_effects
         set status=case when ${terminal} then 'terminal_failed' else 'failed' end,
             error=${message},
             locked_at=null,
             finished_at=${now},
             next_attempt_at=${new Date(now.getTime() + postingEffectsBackoffMs(row.attempt_count))},
             terminal_failure_reason = case when ${terminal}
               then ${message} else terminal_failure_reason end,
             terminal_failed_at = case when ${terminal}
               then coalesce(terminal_failed_at, ${now}) else terminal_failed_at end,
             terminal_failed_by = case when ${terminal} and terminal_failed_at is null
               then ${POSTING_EFFECTS_WORKER_IDENTITY} else terminal_failed_by end,
             updated_at=now()
       where id=${row.id} and status='running'
       returning id, org_id, document_id, kind, entry_id,
                 posting_date::text as posting_date, actor_id, attempt_count,
                 terminal_failure_reason, terminal_failed_at, terminal_failed_by,
                 (${terminal}
                  and terminal_failed_by = ${POSTING_EFFECTS_WORKER_IDENTITY}
                  and terminal_failed_at = ${now}) as "becameTerminal"
    `);
    const terminalRow = result.rows[0];
    if (terminalRow?.becameTerminal) await insertTerminalFailureAudit(tx, terminalRow);
    return terminalRow;
  });
  if (marked?.becameTerminal) emitTerminalFailure(marked);
}

export type PostingEffectsRunner = (row: PostingEffectsRow) => Promise<void>;

/** Claim and drain due work. Terminal rows are deliberately outside the due
 * predicate and remain visible until an authorized replay resets the lifecycle. */
export async function processDuePostingEffects(
  now = new Date(),
  limit = 50,
  run?: PostingEffectsRunner,
): Promise<{ processed: number; succeeded: number; failed: number }> {
  await recoverStalePostingEffects(now);
  const drain =
    run ??
    (async (row: PostingEffectsRow) => {
      const { runPostDocumentEffects } = await import("./posting.ts");
      await runPostDocumentEffects(row.document_id, "approved", {
        actorId: row.actor_id,
        alreadyClaimed: row,
      });
    });
  const batch = Math.max(1, Math.min(limit, 200));
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  for (let i = 0; i < batch; i++) {
    const row = await claimNextDuePostingEffects(now);
    if (!row) break;
    processed++;
    const startedAt = Date.now();
    try {
      await runInSpan(
        "outbox.attempt",
        {
          [ATTR_SURFACE]: "posting_effects",
          [ATTR_KIND]: row.kind,
          [ATTR_ORG_ID]: row.org_id,
          [ATTR_ROW_ID]: row.id,
        },
        () => drain(row),
      );
      await markPostingEffectsSucceeded(row, now);
      succeeded++;
      recordOutboxAttempt("posting_effects", row.kind, "succeeded", Date.now() - startedAt);
    } catch (error) {
      await markPostingEffectsFailed(row, error, now);
      failed++;
      recordOutboxAttempt("posting_effects", row.kind, "failed", Date.now() - startedAt);
      console.error(`[posting-effects] ${row.kind} ${row.document_id} failed:`, error);
    }
  }
  return { processed, succeeded, failed };
}

export type FailedPostingEffect = {
  id: string;
  orgId: string;
  documentId: string;
  kind: string;
  status: "failed" | "terminal_failed";
  attemptCount: number;
  error: string | null;
  nextAttemptAt: Date;
  lastAttemptAt: Date | null;
  finishedAt: Date | null;
  terminalFailureReason: string | null;
  terminalFailedAt: Date | null;
  terminalFailedBy: string | null;
};

/** Privileged operator query. Tenant scope is mandatory even though the
 * implementation crosses the RLS bypass boundary. */
export async function listFailedPostingEffects(
  orgId: string,
  limit = 100,
): Promise<FailedPostingEffect[]> {
  if (!orgId) throw new PostingEffectsReplayError("organization id is required");
  const result = await withBypassContext(() => db.execute<FailedPostingEffect>(sql`
    select id, org_id as "orgId", document_id as "documentId", kind, status,
           attempt_count as "attemptCount", error,
           next_attempt_at as "nextAttemptAt", last_attempt_at as "lastAttemptAt",
           finished_at as "finishedAt",
           terminal_failure_reason as "terminalFailureReason",
           terminal_failed_at as "terminalFailedAt",
           terminal_failed_by as "terminalFailedBy"
      from posting_effects
     where org_id=${orgId} and status in ('failed','terminal_failed')
     order by coalesce(terminal_failed_at, finished_at, updated_at) desc
     limit ${Math.max(1, Math.min(limit, 500))}
  `));
  return result.rows;
}

/** Authorized remediation for poison work. The prior terminal envelope is
 * copied into immutable audit_log before the live row is reset for replay. */
export async function replayTerminalPostingEffect(input: {
  orgId: string;
  id: string;
  actorId: string;
  reason: string;
  now?: Date;
}): Promise<void> {
  const reason = input.reason.trim();
  if (reason.length < 10 || reason.length > 1000) {
    throw new PostingEffectsReplayError("replay reason must be between 10 and 1000 characters");
  }
  const now = input.now ?? new Date();
  await withBypassContext(() => db.transaction(async (tx) => {
    const actor = await tx.execute<{ exists: boolean }>(sql`
      select exists (
        select 1 from users
         where id=${input.actorId} and org_id=${input.orgId} and is_active
      ) as exists
    `);
    if (!actor.rows[0]?.exists) {
      throw new PostingEffectsReplayError("replay actor is not an active user in the organization");
    }
    const selected = await tx.execute<{
      status: string;
      attempt_count: number;
      terminal_failure_reason: string | null;
      terminal_failed_at: Date | null;
      terminal_failed_by: string | null;
      document_id: string;
      kind: string;
    }>(sql`
      select status, attempt_count, terminal_failure_reason, terminal_failed_at,
             terminal_failed_by, document_id, kind
        from posting_effects
       where id=${input.id} and org_id=${input.orgId}
       for update
    `);
    const before = selected.rows[0];
    if (!before) throw new PostingEffectsReplayError("posting effect was not found in the organization");
    if (before.status !== "terminal_failed") {
      throw new PostingEffectsReplayError("only terminal-failed posting effects can be replayed");
    }
    await tx.execute(sql`
      update posting_effects
         set status='pending', attempt_count=0, next_attempt_at=${now},
             locked_at=null, last_attempt_at=null, finished_at=null, error=null,
             terminal_failure_reason=null, terminal_failed_at=null,
             terminal_failed_by=null, updated_at=now(), updated_by=${input.actorId}
       where id=${input.id} and org_id=${input.orgId} and status='terminal_failed'
    `);
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id, request_id, at)
      values (
        ${input.orgId}, 'posting_effects', ${input.id}, 'update',
        ${JSON.stringify({
          event: "posting_effects_replay_authorized",
          reason,
          before: {
            status: before.status,
            attemptCount: before.attempt_count,
            terminalFailureReason: before.terminal_failure_reason,
            terminalFailedAt: before.terminal_failed_at,
            terminalFailedBy: before.terminal_failed_by,
          },
          after: { status: "pending", attemptCount: 0, nextAttemptAt: now },
          documentId: before.document_id,
          kind: before.kind,
        })}::jsonb,
        ${input.actorId}, 'posting_effects_replay', ${now}
      )
    `);
  }));
}
