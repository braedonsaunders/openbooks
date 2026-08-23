import { sql } from "drizzle-orm";
import { db, withBypassContext } from "./db.ts";

/**
 * Durable scheduler/approval-escalation outbox — same claim/run/fail/retry
 * contract as report_runs / report_delivery_outbox. Redis queues are optional
 * and rebuildable; this table is the source of truth after a crash.
 */

export const SCHEDULER_OUTBOX_SCAN_KINDS = [
  "dunning",
  "subscription_billing",
  "property_billing",
  "fx_providers",
] as const;

export type SchedulerOutboxScanKind = (typeof SCHEDULER_OUTBOX_SCAN_KINDS)[number];
export type SchedulerOutboxKind = SchedulerOutboxScanKind | "approval_escalation";

export const MAX_SCHEDULER_OUTBOX_ATTEMPTS = 8;
export const STALE_SCHEDULER_OUTBOX_MS = 15 * 60_000;
const SCAN_REQUEUE_MS = 55_000;

export type OutboxRow = {
  id: string;
  org_id: string | null;
  kind: SchedulerOutboxKind;
  subject_id: string | null;
  occurrence_key: string;
  attempt_count: number;
};

export function schedulerOutboxBackoffMs(attemptCount: number): number {
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attemptCount - 1));
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

/** Insert the singleton scan rows once; later ticks claim and reuse them. */
export async function ensureScanOutboxRows(): Promise<void> {
  for (const kind of SCHEDULER_OUTBOX_SCAN_KINDS) {
    await db.execute(sql`
      insert into scheduler_outbox (kind, occurrence_key, status, next_attempt_at)
      values (${kind}, ${kind}, 'pending', now())
      on conflict (kind, occurrence_key) do nothing
    `);
  }
}

/** Persist a due approval escalation so a crash cannot drop it. */
export async function enqueueApprovalEscalation(input: {
  orgId: string;
  gateId: string;
}): Promise<string | null> {
  const inserted = (await db.execute<{ id: string }>(sql`
    insert into scheduler_outbox
      (org_id, kind, subject_id, occurrence_key, status, next_attempt_at)
    values (${input.orgId}, 'approval_escalation', ${input.gateId}, ${input.gateId}, 'pending', now())
    on conflict (kind, occurrence_key) do nothing
    returning id
  `));
  return inserted.rows[0]?.id ?? null;
}

/** Release crash-orphaned running rows so the next tick can retry. */
export async function recoverStaleSchedulerOutbox(now = new Date()): Promise<number> {
  const recovered = (await db.execute(sql`
    update scheduler_outbox
       set status='failed',
           error=coalesce(error, 'stale lock recovered after crash'),
           locked_at=null,
           next_attempt_at=${now},
           updated_at=now()
     where status='running'
       and locked_at is not null
       and locked_at < ${new Date(now.getTime() - STALE_SCHEDULER_OUTBOX_MS)}
  `));
  return recovered.rowCount ?? 0;
}

async function runOutboxWork(row: OutboxRow): Promise<void> {
  if (row.kind === "dunning") {
    const { runDunning } = await import("./dunning.ts");
    await runDunning();
    return;
  }
  if (row.kind === "subscription_billing") {
    const { runDueSubscriptions } = await import("./subscription-billing.ts");
    await runDueSubscriptions();
    return;
  }
  if (row.kind === "property_billing") {
    const { runDuePropertyBilling } = await import("./property-management.ts");
    await runDuePropertyBilling();
    return;
  }
  if (row.kind === "fx_providers") {
    const { runDueFxProviders } = await import("./fx-providers.ts");
    await runDueFxProviders();
    return;
  }
  if (!row.subject_id) throw new Error("approval escalation is missing its gate");
  const { escalateDueGate } = await import("./flows/gates.ts");
  await escalateDueGate(row.subject_id);
}

async function markSucceeded(row: OutboxRow, now: Date): Promise<void> {
  if (row.kind === "approval_escalation") {
    await db.execute(sql`
      update scheduler_outbox
         set status='succeeded', error=null, locked_at=null, finished_at=${now},
             next_attempt_at=${now}, updated_at=now()
       where id=${row.id}
    `);
    return;
  }
  await db.execute(sql`
    update scheduler_outbox
       set status='pending', error=null, locked_at=null, finished_at=${now},
           attempt_count=0, next_attempt_at=${new Date(now.getTime() + SCAN_REQUEUE_MS)},
           updated_at=now()
     where id=${row.id}
  `);
}

async function markFailed(row: OutboxRow, error: unknown, now: Date): Promise<void> {
  await db.execute(sql`
    update scheduler_outbox
       set status='failed',
           error=${errorMessage(error)},
           locked_at=null,
           finished_at=${now},
           next_attempt_at=${new Date(now.getTime() + schedulerOutboxBackoffMs(row.attempt_count))},
           updated_at=now()
     where id=${row.id}
  `);
}

export type SchedulerOutboxRunner = (row: OutboxRow) => Promise<void>;

/**
 * Claim due pending/failed rows, run them, and leave a visible failure reason
 * when the work throws or the process dies mid-run. Terminal failures stay
 * `failed` once attempt_count reaches MAX_SCHEDULER_OUTBOX_ATTEMPTS.
 */
export async function processDueSchedulerOutbox(
  now = new Date(),
  limit = 50,
  run: SchedulerOutboxRunner = runOutboxWork,
): Promise<{ processed: number; succeeded: number; failed: number }> {
  await recoverStaleSchedulerOutbox(now);
  const due = (await db.execute<{ id: string }>(sql`
    select id from scheduler_outbox
     where status in ('pending','failed')
       and attempt_count < ${MAX_SCHEDULER_OUTBOX_ATTEMPTS}
       and next_attempt_at <= ${now}
     order by next_attempt_at
     limit ${Math.max(1, Math.min(limit, 200))}
  `));
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  for (const candidate of due.rows) {
    const claimed = (await db.execute<OutboxRow>(sql`
      update scheduler_outbox
         set status='running',
             attempt_count=attempt_count+1,
             locked_at=${now},
             last_attempt_at=${now},
             error=null,
             updated_at=now()
       where id=${candidate.id}
         and status in ('pending','failed')
         and attempt_count < ${MAX_SCHEDULER_OUTBOX_ATTEMPTS}
       returning id, org_id, kind, subject_id, occurrence_key, attempt_count
    `));
    const row = claimed.rows[0];
    if (!row) continue;
    processed++;
    try {
      await run(row);
      await markSucceeded(row, now);
      succeeded++;
    } catch (error) {
      await markFailed(row, error, now);
      failed++;
      console.error(`[scheduler-outbox] ${row.kind} ${row.id} failed:`, error);
    }
  }
  return { processed, succeeded, failed };
}

/** Operator visibility after a crash: terminal and retrying failures stay here. */
export async function listFailedSchedulerOutbox(limit = 100): Promise<Array<{
  id: string;
  orgId: string | null;
  kind: SchedulerOutboxKind;
  subjectId: string | null;
  status: string;
  attemptCount: number;
  error: string | null;
  nextAttemptAt: Date | null;
  finishedAt: Date | null;
}>> {
  const rows = await withBypassContext(() => db.execute<{
    id: string;
    orgId: string | null;
    kind: SchedulerOutboxKind;
    subjectId: string | null;
    status: string;
    attemptCount: number;
    error: string | null;
    nextAttemptAt: Date | null;
    finishedAt: Date | null;
  }>(sql`
    select id, org_id as "orgId", kind, subject_id as "subjectId", status,
           attempt_count as "attemptCount", error, next_attempt_at as "nextAttemptAt",
           finished_at as "finishedAt"
      from scheduler_outbox
     where status='failed'
     order by coalesce(finished_at, updated_at) desc
     limit ${Math.max(1, Math.min(limit, 500))}
  `));
  return rows.rows;
}
