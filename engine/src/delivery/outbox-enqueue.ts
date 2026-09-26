/**
 * Scheduler-outbox ENQUEUE half: the fail-closed constructors that persist
 * transactional email and approval-escalation rows through the caller's own
 * transaction. Moved verbatim from scheduling/outbox.ts; the drain half
 * (claim/run/fail/replay/deliverFlowEmail/runOutboxWork)
 * stays in scheduling and imports these back. Depends only on db,
 * @openbooks/emails and @openbooks/jobs types, so flows, receivables and
 * automations can enqueue without importing the scheduling orchestrator.
 */
import { sql } from "drizzle-orm";
import type { EmailJobData } from "@openbooks/jobs";
import { normalizeEmailDeliveryInput, type EmailAttachmentPayload } from "@openbooks/emails";
import { db } from "../platform/db.ts";
export const MAX_SCHEDULER_OUTBOX_ATTEMPTS = 8;
export const STALE_SCHEDULER_OUTBOX_MS = 15 * 60_000;
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
  attachments?: EmailAttachmentPayload[];
  meta?: EmailJobData["meta"];
  /** Per-message Reply-To (dunning policy setting); absent means the org default. */
  replyTo?: string;
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
  const { to, subject, html, text, replyTo } = raw;
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
  // The strict mailbox check runs downstream at enqueue (normalize), but a
  // value that is not even shaped like an address must not become durable.
  let parsedReplyTo: string | undefined;
  if (replyTo !== undefined) {
    if (typeof replyTo !== "string" || !replyTo.includes("@")) {
      throw malformed("`replyTo` must be an email address");
    }
    parsedReplyTo = replyTo;
  }
  return {
    to, subject, html, text,
    ...(attachments ? { attachments } : {}),
    ...(meta ? { meta } : {}),
    ...(parsedReplyTo ? { replyTo: parsedReplyTo } : {}),
  };
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
  // Fail closed on the exact delivery contract the queue enforces at drain:
  // an invalid recipient, subject, reply-to, or attachment must refuse here,
  // synchronously inside the flow's transaction — never commit as a
  // successful send that only surfaces as an error at drain time, after the
  // flow already reported success.
  try {
    normalizeEmailDeliveryInput({
      to: input.payload.to,
      subject: input.payload.subject,
      html: input.payload.html,
      text: input.payload.text,
      ...(input.payload.attachments ? { attachments: input.payload.attachments } : {}),
      ...(input.payload.replyTo ? { replyTo: input.payload.replyTo } : {}),
    });
  } catch (error) {
    throw new Error(
      `flow email refused: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
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
export function schedulerOutboxBackoffMs(attemptCount: number): number {
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attemptCount - 1));
}
/**
 * Worst-case wall-clock horizon for one outbox row to drain: the stale-lock
 * recovery window plus every backoff between the maximum attempts. A staged
 * dunning claim older than this can never still be awaiting its letter — its
 * outbox row is terminal or long dead — so the dunning runner re-arms it
 * instead of letting it block the rung forever.
 */
export const SCHEDULER_OUTBOX_RETRY_HORIZON_MS =
  STALE_SCHEDULER_OUTBOX_MS +
  Array.from({ length: MAX_SCHEDULER_OUTBOX_ATTEMPTS }, (_, index) =>
    schedulerOutboxBackoffMs(index + 1),
  ).reduce((total, backoff) => total + backoff, 0);
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
