import { sql } from "drizzle-orm";
import type { EmailJobData } from "@openbooks/jobs";
import { db, withBypassContext } from "./db.ts";
import {
  logTerminalFailure,
  SCHEDULER_OUTBOX_WORKER_IDENTITY,
} from "./terminal-failure.ts";
import {
  ATTR_KIND,
  ATTR_ORG_ID,
  ATTR_ROW_ID,
  ATTR_SURFACE,
  runInSpan,
  recordOutboxAttempt,
} from "./telemetry.ts";

/**
 * Durable scheduler/approval-escalation outbox — same claim/run/fail/retry
 * contract as report_runs / report_delivery_outbox. Redis queues are optional
 * and rebuildable; this table is the source of truth after a crash.
 *
 * `flow_email` rows are how transactional flows defer mail past their caller's
 * commit: the rendered delivery is inserted through the caller's own
 * transaction (a rollback discards it together with the flow's other
 * effects), and this worker delivers it later through the Redis queue. A
 * deterministic occurrence key makes replays of one effect collapse onto a
 * single row instead of duplicating sends.
 *
 * Terminal failures are not silent: the single attempt whose failure reaches
 * MAX_SCHEDULER_OUTBOX_ATTEMPTS stamps terminal_failed_at / terminal_failed_by
 * on the row (exactly once — later attempts cannot exist because claims require
 * attempt_count < ceiling) and emits one structured
 * "scheduler.terminal_failure" log line plus one `openbooks.terminal_failures`
 * metric increment (see telemetry.ts). Crash recovery of a stale running row
 * that was already at the ceiling performs the same transition. Operators alert
 * on poison scans with:
 *
 *   select kind, id, org_id, error, attempt_count, terminal_failed_at,
 *          terminal_failed_by
 *     from scheduler_outbox where terminal_failed_at is not null
 *    order by terminal_failed_at desc;
 *
 * (see terminal-failure.ts for the sibling report_runs /
 * report_delivery_outbox queries).
 */

export const SCHEDULER_OUTBOX_SCAN_KINDS = [
  "dunning",
  "subscription_billing",
  "property_billing",
  "fx_providers",
] as const;

export type SchedulerOutboxScanKind = (typeof SCHEDULER_OUTBOX_SCAN_KINDS)[number];
export type SchedulerOutboxKind =
  | SchedulerOutboxScanKind
  | "approval_escalation"
  | "flow_email";

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
  lease_token: string;
  payload: unknown;
};

/**
 * The rendered delivery a flow produced at execution time. Persisted verbatim
 * on the outbox row: the eventual send must not depend on the record's later
 * state (template values, recipients, or PDFs can all change before the
 * worker drains).
 */
export interface FlowEmailPayload {
  to: string[];
  subject: string;
  html: string;
  text: string;
  attachments?: EmailJobData["attachments"];
  meta?: EmailJobData["meta"];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(detail: string): Error {
  return new Error(`flow email payload is malformed: ${detail}`);
}

/**
 * Fail-closed validation for flow_email deliveries. Runs at enqueue time (so
 * a bad payload never becomes durable) and again at drain time (so storage
 * tampering or an older writer surfaces as a retryable, operator-visible
 * failure instead of a garbage send).
 */
export function parseFlowEmailPayload(raw: unknown): FlowEmailPayload {
  if (!isPlainObject(raw)) throw malformed("expected an object");
  const { to, subject, html, text } = raw;
  if (!Array.isArray(to) || to.length === 0) throw malformed("`to` must be a non-empty array");
  for (const recipient of to) {
    if (typeof recipient !== "string" || !recipient.includes("@")) {
      throw malformed("`to` entries must be email addresses");
    }
  }
  if (typeof subject !== "string") throw malformed("`subject` must be a string");
  if (typeof html !== "string") throw malformed("`html` must be a string");
  if (typeof text !== "string") throw malformed("`text` must be a string");
  let attachments: FlowEmailPayload["attachments"];
  if (raw.attachments !== undefined) {
    if (!Array.isArray(raw.attachments)) throw malformed("`attachments` must be an array");
    attachments = raw.attachments.map((attachment) => {
      if (!isPlainObject(attachment)) throw malformed("attachments must be objects");
      if (typeof attachment.filename !== "string" || attachment.filename.length === 0) {
        throw malformed("attachment filename is required");
      }
      if (typeof attachment.content !== "string") {
        throw malformed("attachment content must be base64 text");
      }
      if (attachment.contentType !== undefined && typeof attachment.contentType !== "string") {
        throw malformed("attachment contentType must be a string");
      }
      return {
        filename: attachment.filename,
        content: attachment.content,
        ...(attachment.contentType === undefined ? {} : { contentType: attachment.contentType }),
      };
    });
  }
  let meta: FlowEmailPayload["meta"];
  if (raw.meta !== undefined) {
    if (!isPlainObject(raw.meta)) throw malformed("`meta` must be an object");
    for (const [key, value] of Object.entries(raw.meta)) {
      if (typeof value !== "string") throw malformed(`\`meta.${key}\` must be a string`);
    }
    meta = raw.meta as EmailJobData["meta"];
  }
  return { to, subject, html, text, ...(attachments ? { attachments } : {}), ...(meta ? { meta } : {}) };
}

/**
 * Defer one rendered flow email through the durable outbox. The insert rides
 * whatever database transaction the caller owns (`db` routes to the ambient
 * pinned transaction), so a rolled-back business operation discards the
 * pending send instead of delivering mail for effects that never committed.
 *
 * Returns true when this call won the right to deliver — replays carrying the
 * same occurrence key collapse onto the existing row and return false.
 */
export async function enqueueFlowEmail(input: {
  orgId: string;
  /** Owning flow run; kept on subject_id so operators can trace failures. */
  runId: string;
  /** Deterministic per-effect key; retries of one effect share it. */
  occurrenceKey: string;
  payload: FlowEmailPayload;
}): Promise<boolean> {
  if (!input.orgId) throw new Error("flow email requires its organization");
  if (!input.runId) throw new Error("flow email requires its flow run");
  if (!input.occurrenceKey) throw new Error("flow email requires an occurrence key");
  parseFlowEmailPayload(input.payload);
  const inserted = (await db.execute<{ id: string }>(sql`
    insert into scheduler_outbox
      (org_id, kind, subject_id, occurrence_key, status, next_attempt_at, payload)
    values (${input.orgId}, 'flow_email', ${input.runId}, ${input.occurrenceKey}, 'pending', now(),
            ${JSON.stringify(input.payload)}::jsonb)
    on conflict (kind, occurrence_key) do nothing
    returning id
  `));
  return inserted.rows.length > 0;
}

export class SchedulerOutboxLeaseFencedError extends Error {
  constructor(id: string) {
    super(`scheduler-outbox claim ${id} lost its lease and was fenced`);
    this.name = "SchedulerOutboxLeaseFencedError";
  }
}

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

/** Release crash-orphaned running rows so the next tick can retry. A recovered
 * row already at the attempt ceiling is terminal: stamp + log it here, because
 * the normal claim loop will never pick it up again to record the transition. */
export async function recoverStaleSchedulerOutbox(now = new Date()): Promise<number> {
  const recovered = (await db.execute<{
    id: string;
    org_id: string | null;
    kind: SchedulerOutboxKind;
    subject_id: string | null;
    occurrence_key: string;
    attempt_count: number;
    becameTerminal: boolean;
  }>(sql`
    update scheduler_outbox
       set status='failed',
           error=coalesce(error, 'stale lock recovered after crash'),
           locked_at=null,
           lease_token=null,
           next_attempt_at=${now},
           terminal_failed_at = case when attempt_count >= ${MAX_SCHEDULER_OUTBOX_ATTEMPTS}
                                     then coalesce(terminal_failed_at, ${now})
                                     else terminal_failed_at end,
           terminal_failed_by = case when attempt_count >= ${MAX_SCHEDULER_OUTBOX_ATTEMPTS}
                                      and terminal_failed_at is null
                                     then ${SCHEDULER_OUTBOX_WORKER_IDENTITY}
                                     else terminal_failed_by end,
           updated_at=now()
     where status='running'
       and locked_at is not null
       and locked_at < ${new Date(now.getTime() - STALE_SCHEDULER_OUTBOX_MS)}
     returning id, org_id, kind, subject_id, occurrence_key, attempt_count, lease_token,
               (attempt_count >= ${MAX_SCHEDULER_OUTBOX_ATTEMPTS}
                and terminal_failed_by = ${SCHEDULER_OUTBOX_WORKER_IDENTITY}
                and terminal_failed_at = ${now}) as "becameTerminal"
  `));
  for (const row of recovered.rows) {
    if (!row.becameTerminal) continue;
    logTerminalFailure({
      surface: "scheduler_outbox",
      kind: row.kind,
      id: row.id,
      orgId: row.org_id,
      subjectId: row.subject_id,
      attempts: row.attempt_count,
      error: "stale lock recovered after crash at the attempt ceiling",
      markedBy: SCHEDULER_OUTBOX_WORKER_IDENTITY,
      at: now,
    });
  }
  return recovered.rowCount ?? 0;
}

async function runOutboxWork(row: OutboxRow): Promise<void> {
  if (row.kind === "flow_email") {
    if (!row.org_id) throw new Error("flow email is missing its organization");
    // Validate again at the boundary: a payload that cannot be delivered as
    // authored must fail this attempt loudly (retry → terminal failure with
    // operator visibility), never send garbage.
    const delivery = parseFlowEmailPayload(row.payload);
    const { enqueueEmail } = await import("@openbooks/jobs");
    await enqueueEmail({
      orgId: row.org_id,
      to: delivery.to,
      subject: delivery.subject,
      html: delivery.html,
      text: delivery.text,
      ...(delivery.attachments?.length ? { attachments: delivery.attachments } : {}),
      ...(delivery.meta ? { meta: delivery.meta } : {}),
    });
    return;
  }
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
  // Escalations and flow emails are one-shot work: a delivered send is
  // terminal, never re-armed by a later tick.
  if (row.kind === "approval_escalation" || row.kind === "flow_email") {
    const completed = await db.execute(sql`
      update scheduler_outbox
         set status='succeeded', error=null, locked_at=null, lease_token=null, finished_at=${now},
             next_attempt_at=${now}, updated_at=now()
       where id=${row.id} and lease_token=${row.lease_token} and status='running'
    `);
    if (completed.rowCount !== 1) throw new SchedulerOutboxLeaseFencedError(row.id);
    return;
  }
  const completed = await db.execute(sql`
    update scheduler_outbox
       set status='pending', error=null, locked_at=null, lease_token=null, finished_at=${now},
           attempt_count=0, next_attempt_at=${new Date(now.getTime() + SCAN_REQUEUE_MS)},
           updated_at=now()
     where id=${row.id} and lease_token=${row.lease_token} and status='running'
  `);
  if (completed.rowCount !== 1) throw new SchedulerOutboxLeaseFencedError(row.id);
}

async function markFailed(row: OutboxRow, error: unknown, now: Date): Promise<void> {
  const message = errorMessage(error);
  // attempt_count was incremented by this row's claim, so it is the ordinal of
  // the attempt that just failed. Reaching the ceiling here is the one and
  // only transition to terminal; stamp it in the same statement that records
  // the final failure so a crash between them is impossible.
  const terminal = row.attempt_count >= MAX_SCHEDULER_OUTBOX_ATTEMPTS;
  const marked = (await db.execute<{ becameTerminal: boolean }>(sql`
    update scheduler_outbox
       set status='failed',
           error=${message},
           locked_at=null,
           lease_token=null,
           finished_at=${now},
           next_attempt_at=${new Date(now.getTime() + schedulerOutboxBackoffMs(row.attempt_count))},
           terminal_failed_at = case when ${terminal}
                                     then coalesce(terminal_failed_at, ${now})
                                     else terminal_failed_at end,
           terminal_failed_by = case when ${terminal} and terminal_failed_at is null
                                     then ${SCHEDULER_OUTBOX_WORKER_IDENTITY}
                                     else terminal_failed_by end,
           updated_at=now()
     where id=${row.id} and lease_token=${row.lease_token} and status='running'
     returning (${terminal}
                and terminal_failed_by = ${SCHEDULER_OUTBOX_WORKER_IDENTITY}
                and terminal_failed_at = ${now}) as "becameTerminal"
  `));
  if (!marked.rows[0]) throw new SchedulerOutboxLeaseFencedError(row.id);
  if (marked.rows[0]?.becameTerminal) {
    logTerminalFailure({
      surface: "scheduler_outbox",
      kind: row.kind,
      id: row.id,
      orgId: row.org_id,
      subjectId: row.subject_id,
      attempts: row.attempt_count,
      error: message,
      markedBy: SCHEDULER_OUTBOX_WORKER_IDENTITY,
      at: now,
    });
  }
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
): Promise<{ processed: number; succeeded: number; failed: number; fenced: number }> {
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
  let fenced = 0;
  for (const candidate of due.rows) {
    const claimed = (await db.execute<OutboxRow>(sql`
      update scheduler_outbox
         set status='running',
             attempt_count=attempt_count+1,
             locked_at=${now},
             lease_token=gen_random_uuid(),
             last_attempt_at=${now},
             error=null,
             updated_at=now()
       where id=${candidate.id}
          and status in ('pending','failed')
          and attempt_count < ${MAX_SCHEDULER_OUTBOX_ATTEMPTS}
        returning id, org_id, kind, subject_id, occurrence_key, attempt_count, lease_token, payload
     `));
    const row = claimed.rows[0];
    if (!row) continue;
    processed++;
    const startedAt = Date.now();
    try {
      await runInSpan(
        "outbox.attempt",
        {
          [ATTR_SURFACE]: "scheduler_outbox",
          [ATTR_KIND]: row.kind,
          ...(row.org_id ? { [ATTR_ORG_ID]: row.org_id } : {}),
          [ATTR_ROW_ID]: row.id,
        },
        () => run(row),
      );
      await markSucceeded(row, now);
      succeeded++;
      recordOutboxAttempt("scheduler_outbox", row.kind, "succeeded", Date.now() - startedAt);
    } catch (error) {
      if (error instanceof SchedulerOutboxLeaseFencedError) {
        fenced++;
        recordOutboxAttempt("scheduler_outbox", row.kind, "failed", Date.now() - startedAt);
        console.warn(`[scheduler-outbox] ${row.kind} ${row.id} completion fenced`);
        continue;
      }
      try {
        await markFailed(row, error, now);
      } catch (completionError) {
        if (!(completionError instanceof SchedulerOutboxLeaseFencedError)) throw completionError;
        fenced++;
        recordOutboxAttempt("scheduler_outbox", row.kind, "failed", Date.now() - startedAt);
        console.warn(`[scheduler-outbox] ${row.kind} ${row.id} failure completion fenced`);
        continue;
      }
      failed++;
      recordOutboxAttempt("scheduler_outbox", row.kind, "failed", Date.now() - startedAt);
      console.error(`[scheduler-outbox] ${row.kind} ${row.id} failed:`, error);
    }
  }
  return { processed, succeeded, failed, fenced };
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
  terminalFailedAt: Date | null;
  terminalFailedBy: string | null;
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
    terminalFailedAt: Date | null;
    terminalFailedBy: string | null;
  }>(sql`
    select id, org_id as "orgId", kind, subject_id as "subjectId", status,
           attempt_count as "attemptCount", error, next_attempt_at as "nextAttemptAt",
           finished_at as "finishedAt",
           terminal_failed_at as "terminalFailedAt", terminal_failed_by as "terminalFailedBy"
      from scheduler_outbox
     where status='failed'
     order by coalesce(finished_at, updated_at) desc
     limit ${Math.max(1, Math.min(limit, 500))}
  `));
  return rows.rows;
}
