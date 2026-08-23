import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "./db.ts";

/**
 * Durable posting-effects outbox — same claim/run/fail/retry contract as
 * report_delivery_outbox / scheduler_outbox. The journal commits first; a
 * crash leaves this row so a worker can call `runPostDocumentEffects`.
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

export function postingEffectsBackoffMs(attemptCount: number): number {
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attemptCount - 1));
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
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

export async function recoverStalePostingEffects(now = new Date()): Promise<number> {
  const recovered = (await db.execute(sql`
    update posting_effects
       set status='failed',
           error=coalesce(error, 'stale lock recovered after crash'),
           locked_at=null,
           next_attempt_at=${now},
           updated_at=now()
     where status='running'
       and locked_at is not null
       and locked_at < ${new Date(now.getTime() - STALE_POSTING_EFFECTS_MS)}
  `));
  return recovered.rowCount ?? 0;
}

/** Claim the pending/failed row for one posted document (happy-path drain). */
export async function claimPostingEffectsForDocument(
  documentId: string,
  now = new Date(),
): Promise<PostingEffectsRow | "succeeded" | "running" | null> {
  const claimed = (await db.execute<PostingEffectsRow>(sql`
    update posting_effects as claimed
       set status='running',
           attempt_count=attempt_count+1,
           locked_at=${now},
           last_attempt_at=${now},
           error=null,
           updated_at=now()
     where claimed.document_id = ${documentId}
       and claimed.status in ('pending','failed')
       and claimed.attempt_count < ${MAX_POSTING_EFFECTS_ATTEMPTS}
     returning claimed.id, claimed.org_id, claimed.document_id, claimed.kind, claimed.entry_id,
               claimed.posting_date::text as posting_date, claimed.actor_id, claimed.attempt_count
  `));
  if (claimed.rows[0]) return claimed.rows[0];
  const existing = (await db.execute<{ status: string }>(sql`
    select status from posting_effects where document_id = ${documentId}
  `));
  const status = existing.rows[0]?.status;
  if (status === "succeeded") return "succeeded";
  if (status === "running" || status === "failed") return "running";
  return null;
}

async function claimNextDuePostingEffects(now: Date): Promise<PostingEffectsRow | null> {
  const claimed = (await db.execute<PostingEffectsRow>(sql`
    update posting_effects as claimed
       set status='running',
           attempt_count=attempt_count+1,
           locked_at=${now},
           last_attempt_at=${now},
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
  `));
  return claimed.rows[0] ?? null;
}

export async function markPostingEffectsSucceeded(row: PostingEffectsRow, now = new Date()): Promise<void> {
  await db.execute(sql`
    update posting_effects
       set status='succeeded', error=null, locked_at=null, finished_at=${now},
           next_attempt_at=${now}, updated_at=now()
     where id=${row.id}
  `);
}

export async function markPostingEffectsFailed(
  row: PostingEffectsRow,
  error: unknown,
  now = new Date(),
): Promise<void> {
  await db.execute(sql`
    update posting_effects
       set status='failed',
           error=${errorMessage(error)},
           locked_at=null,
           finished_at=${now},
           next_attempt_at=${new Date(now.getTime() + postingEffectsBackoffMs(row.attempt_count))},
           updated_at=now()
     where id=${row.id}
  `);
}

export type PostingEffectsRunner = (
  row: PostingEffectsRow,
) => Promise<void>;

/**
 * Claim due pending/failed rows and drain them through `runPostDocumentEffects`.
 * A crash after the posting commit leaves the row; the next tick retries it.
 */
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
    try {
      await drain(row);
      await markPostingEffectsSucceeded(row, now);
      succeeded++;
    } catch (error) {
      await markPostingEffectsFailed(row, error, now);
      failed++;
      console.error(`[posting-effects] ${row.kind} ${row.document_id} failed:`, error);
    }
  }
  return { processed, succeeded, failed };
}
