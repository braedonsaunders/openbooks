import { sql } from "drizzle-orm";
import type { EmailJobData, EnqueueEmailData } from "@openbooks/jobs";
import { db, type SqlExecutor, withBypassContext } from "./db.ts";
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
 * single row instead of duplicating sends, and the queued send itself carries
 * a deterministic job id derived from the row identity (flowEmailJobId), so a
 * worker that dies between enqueueing the provider call and marking success
 * collapses its recovery retry onto the SAME queue job instead of sending a
 * second copy of the customer's mail.
 *
 * Terminal failures are not silent: the single attempt whose failure reaches
 * MAX_SCHEDULER_OUTBOX_ATTEMPTS stamps terminal_failed_at / terminal_failed_by
 * on the row (exactly once — later attempts cannot exist because claims require
 * attempt_count < ceiling) and writes one append-only evidence row into
 * scheduler_outbox_terminal_audit inside that same transaction, for crash
 * recovery of an at-ceiling stale row exactly like ordinary exhaustion (see
 * migration 0026_scheduler_outbox_terminal_audit.sql for the storage-side
 * immutability guards and backfill). In addition to that structured
 * "scheduler.terminal_failure" log line plus the
 * `openbooks.terminal_failures` metric increment (see telemetry.ts), the
 * evidence table now IS the independent durable record: terminal-stamped rows
 * are frozen by storage — no rewrite and no delete without the authorized
 * replay contract below. Operators alert on poison scans with:
 *
 *   select o.kind, o.id, o.org_id, o.error, o.attempt_count,
 *          o.terminal_failed_at, o.terminal_failed_by, e.event, e.reason, e.at
 *     from scheduler_outbox o
 *     join scheduler_outbox_terminal_audit e on e.outbox_row_id = o.id
 *    where o.terminal_failed_at is not null
 *    order by e.at desc;
 *
 * Authorized remediation is replayTerminalSchedulerOutbox: it validates the
 * operator, writes a replay_authorized evidence row carrying the verbatim
 * before/after envelope, and only then clears the stamp under a
 * transaction-scoped pin the storage guard enforces.
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
 * The Redis-side handoff for one durable flow_email row. Deterministic job ids
 * (flowEmailJobId) make BullMQ collapse a post-enqueue/pre-mark crash onto the
 * already-enqueued send instead of queueing a second one on stale-recovery
 * retry; report-delivery.ts's generation ids follow the same contract.
 */
export type FlowEmailQueueEnqueuer = (
  data: EnqueueEmailData,
  options?: { jobId?: string },
) => Promise<unknown>;

/**
 * The deterministic queue identity of one flow_email outbox row: a pure
 * function of the row's primary key — the immutable per-effect identity every
 * attempt shares — so a first send and its crash-gap retry collapse onto one
 * queued job and BullMQ refuses to insert it twice.
 */
export function flowEmailJobId(outboxRowId: string): string {
  return `flow-email|${outboxRowId}`;
}

/** Reach the shared BullMQ producer lazily so scan-only workers never load it. */
async function enqueueFlowEmailJob(
  data: EnqueueEmailData,
  options?: { jobId?: string },
): Promise<unknown> {
  const { enqueueEmail } = await import("@openbooks/jobs");
  return enqueueEmail(data, options);
}

/**
 * Deliver one durable flow_email row through the Redis queue with a
 * deterministic per-recipient job id derived from the row identity. The
 * enqueuer is injectable for tests; production always uses the real queue.
 */
export async function deliverFlowEmail(
  row: OutboxRow,
  enqueue: FlowEmailQueueEnqueuer = enqueueFlowEmailJob,
): Promise<void> {
  if (!row.org_id) throw new Error("flow email is missing its organization");
  // Validate again at the boundary: a payload that cannot be delivered as
  // authored must fail this attempt loudly (retry → terminal failure with
  // operator visibility), never send garbage.
  const delivery = parseFlowEmailPayload(row.payload);
  await enqueue(
    {
      orgId: row.org_id,
      to: delivery.to,
      subject: delivery.subject,
      html: delivery.html,
      text: delivery.text,
      ...(delivery.attachments?.length ? { attachments: delivery.attachments } : {}),
      ...(delivery.meta ? { meta: delivery.meta } : {}),
    },
    // One stable identity per row closes the DB/Redis crash gap: if the
    // process dies between this enqueue and the PG success mark, the
    // recovered row retries onto the same job instead of a duplicate send.
    { jobId: flowEmailJobId(row.id) },
  );
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

export class SchedulerOutboxReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchedulerOutboxReplayError";
  }
}

export function schedulerOutboxBackoffMs(attemptCount: number): number {
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attemptCount - 1));
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

/** The identity columns a terminal transition certifies, verbatim from the row
 * it terminalizes — including org-less system scans, whose poison deserves
 * evidence exactly like tenant poison. */
type SchedulerOutboxEnvelope = {
  id: string;
  org_id: string | null;
  kind: SchedulerOutboxKind;
  subject_id: string | null;
  occurrence_key: string;
  attempt_count: number;
};

type TerminalEvidenceEvent = "terminal_failure" | "crash_recovery_terminal_failure";

/**
 * Append the independent durable record of one terminal transition. Must be
 * awaited inside the SAME transaction as the stamping UPDATE (migration 0026):
 * storage refuses a second evidence row for one occurrence and refuses to let
 * terminalization commit without this insert.
 */
async function insertTerminalFailureEvidence(
  tx: SqlExecutor,
  event: TerminalEvidenceEvent,
  row: SchedulerOutboxEnvelope,
  fields: { statusBefore: string; reason: string; markedBy: string; at: Date },
): Promise<void> {
  await tx.execute(sql`
    insert into scheduler_outbox_terminal_audit
      (outbox_row_id, event, org_id, kind, subject_id, occurrence_key,
       attempt_count, reason, marked_by, at, detail)
    values (${row.id}, ${event}, ${row.org_id}, ${row.kind}, ${row.subject_id},
            ${row.occurrence_key}, ${row.attempt_count}, ${fields.reason},
            ${fields.markedBy}, ${fields.at},
            ${JSON.stringify({
              event: "scheduler_outbox_terminal_failure",
              path: event === "terminal_failure" ? "exhaustion" : "crash_recovery",
              before: { status: fields.statusBefore, attemptCount: row.attempt_count },
              after: {
                status: "failed",
                attemptCount: row.attempt_count,
                reason: fields.reason,
                terminalFailedAt: fields.at,
                terminalFailedBy: fields.markedBy,
              },
              kind: row.kind,
              occurrenceKey: row.occurrence_key,
            })}::jsonb)
  `);
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
 * row already at the attempt ceiling is terminal: stamp it, write its
 * append-only crash-recovery evidence in the same transaction, and log it
 * here — because the normal claim loop will never pick that row up again to
 * record the transition. */
export async function recoverStaleSchedulerOutbox(now = new Date()): Promise<number> {
  const recovered = await db.transaction(async (tx) => {
    const result = (await tx.execute<{
      id: string;
      org_id: string | null;
      kind: SchedulerOutboxKind;
      subject_id: string | null;
      occurrence_key: string;
      attempt_count: number;
      lease_token: string;
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
    for (const row of result.rows) {
      if (!row.becameTerminal) continue;
      await insertTerminalFailureEvidence(tx, "crash_recovery_terminal_failure", row, {
        statusBefore: "running",
        reason: "stale lock recovered after crash at the attempt ceiling",
        markedBy: SCHEDULER_OUTBOX_WORKER_IDENTITY,
        at: now,
      });
    }
    return result;
  });
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
    await deliverFlowEmail(row);
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
  // the final failure so a crash between them is impossible — and write the
  // append-only evidence row inside that same transaction (migration 0026):
  // terminalization cannot commit without durable evidence.
  const terminal = row.attempt_count >= MAX_SCHEDULER_OUTBOX_ATTEMPTS;
  const marked = await db.transaction(async (tx) => {
    const result = await tx.execute<{ becameTerminal: boolean }>(sql`
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
    `);
    if (result.rows[0]?.becameTerminal) {
      await insertTerminalFailureEvidence(tx, "terminal_failure", row, {
        statusBefore: "running",
        reason: message,
        markedBy: SCHEDULER_OUTBOX_WORKER_IDENTITY,
        at: now,
      });
    }
    return result.rows[0];
  });
  if (!marked) throw new SchedulerOutboxLeaseFencedError(row.id);
  if (marked.becameTerminal) {
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

/** Authorized remediation for poison work. The prior terminal envelope is
 * copied into append-only audit evidence BEFORE the live row is reset for
 * replay; the storage guard refuses to clear the stamps without that prior
 * evidence visible in the same transaction, so an unevidenced reset commits
 * nothing. Mirrors replayTerminalPostingEffect. */
export async function replayTerminalSchedulerOutbox(input: {
  orgId: string;
  id: string;
  actorId: string;
  reason: string;
  now?: Date;
}): Promise<void> {
  const reason = input.reason.trim();
  if (reason.length < 10 || reason.length > 1000) {
    throw new SchedulerOutboxReplayError("replay reason must be between 10 and 1000 characters");
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
      throw new SchedulerOutboxReplayError("replay actor is not an active user in the organization");
    }
    const selected = await tx.execute<{
      id: string;
      org_id: string | null;
      kind: SchedulerOutboxKind;
      subject_id: string | null;
      occurrence_key: string;
      attempt_count: number;
      error: string | null;
      terminal_failed_at: Date | null;
      terminal_failed_by: string | null;
    }>(sql`
      select id, org_id, kind, subject_id, occurrence_key, attempt_count,
             error, terminal_failed_at, terminal_failed_by
        from scheduler_outbox
       where id=${input.id} and org_id=${input.orgId}
         and terminal_failed_at is not null
       for update
    `);
    const before = selected.rows[0];
    if (!before) throw new SchedulerOutboxReplayError("only terminal-failed scheduler outbox rows can be replayed");
    const evidence = await tx.execute<{ exists: boolean }>(sql`
      select exists (
        select 1 from scheduler_outbox_terminal_audit
         where outbox_row_id=${input.id} and event <> 'replay_authorized'
      ) as exists
    `);
    if (!evidence.rows[0]?.exists) {
      throw new SchedulerOutboxReplayError("terminal failure has no durable evidence to replay");
    }
    // Evidence first, authorization pin second, reset last — the storage
    // guard enforces this ordering by refusing the stamp-clearing UPDATE
    // unless both precede it inside this transaction.
    await insertSchedulerOutboxReplayAudit(tx, before, { reason, actorId: input.actorId, at: now });
    await tx.execute(sql`
      select set_config('openbooks.scheduler_outbox_replay_org', ${input.orgId}::text, true)
    `);
    const reset = await tx.execute(sql`
      update scheduler_outbox
         set status='pending', attempt_count=0, next_attempt_at=${now},
             locked_at=null, lease_token=null, last_attempt_at=null,
             finished_at=null, error=null,
             terminal_failed_at=null, terminal_failed_by=null, updated_at=now()
       where id=${input.id} and org_id=${input.orgId}
         and terminal_failed_at is not null
    `);
    if (reset.rowCount !== 1) throw new SchedulerOutboxReplayError("the terminal row was not replayable");
  }));
}

async function insertSchedulerOutboxReplayAudit(
  tx: SqlExecutor,
  before: {
    id: string;
    org_id: string | null;
    kind: SchedulerOutboxKind;
    subject_id: string | null;
    occurrence_key: string;
    attempt_count: number;
    error: string | null;
    terminal_failed_at: Date | null;
    terminal_failed_by: string | null;
  },
  fields: { reason: string; actorId: string; at: Date },
): Promise<void> {
  await tx.execute(sql`
    insert into scheduler_outbox_terminal_audit
      (outbox_row_id, event, org_id, kind, subject_id, occurrence_key,
       attempt_count, reason, marked_by, at, detail)
    values (${before.id}, 'replay_authorized', ${before.org_id}, ${before.kind},
            ${before.subject_id}, ${before.occurrence_key}, ${before.attempt_count},
            ${fields.reason}, ${fields.actorId}, ${fields.at},
            ${JSON.stringify({
              event: "scheduler_outbox_replay_authorized",
              reason: fields.reason,
              before: {
                status: "failed",
                attemptCount: before.attempt_count,
                error: before.error,
                terminalFailedAt: before.terminal_failed_at,
                terminalFailedBy: before.terminal_failed_by,
              },
              after: { status: "pending", attemptCount: 0, nextAttemptAt: fields.at },
              kind: before.kind,
              occurrenceKey: before.occurrence_key,
            })}::jsonb)
  `);
}
