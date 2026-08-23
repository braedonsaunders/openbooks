/**
 * Durable terminal-failure surfacing for background-work outboxes.
 *
 * The claim/run/fail/retry loops in scheduler-outbox.ts and report-delivery.ts
 * stop touching a row once its attempt ceiling is reached; before migration
 * 0006_terminal_failure_surfacing that transition was silent. Every surface
 * now stamps `terminal_failed_at` / `terminal_failed_by` on the poison row
 * itself — exactly once, from the single attempt whose failure exhausts the
 * ceiling, guarded by `coalesce`/`is null` inside the same UPDATE that records
 * the final failure so a crash cannot separate the two facts — and emits one
 * structured log line keyed on this event name:
 *
 *   {"event":"scheduler.terminal_failure","surface":...,"id":...,...}
 *
 * The stamped rows ARE the durable record (one per poison row: timestamp,
 * recording system identity, last error, and attempt count all live on the
 * row); there is deliberately no parallel failure table. Alert on them with:
 *
 *   select kind, id, org_id, subject_id, error, attempt_count,
 *          terminal_failed_at, terminal_failed_by
 *     from scheduler_outbox
 *    where terminal_failed_at is not null
 *    order by terminal_failed_at desc;
 *
 *   select id, org_id, definition_id, error, attempt_count,
 *          terminal_failed_at, terminal_failed_by
 *     from report_runs
 *    where terminal_failed_at is not null
 *    order by terminal_failed_at desc;
 *
 *   select id, org_id, recipient, error, attempt_count,
 *          terminal_failed_at, terminal_failed_by
 *     from report_delivery_outbox
 *    where terminal_failed_at is not null
 *    order by terminal_failed_at desc;
 *
 *   select id, org_id, document_id, kind, terminal_failure_reason,
 *          attempt_count, terminal_failed_at, terminal_failed_by
 *     from posting_effects
 *    where status = 'terminal_failed'
 *    order by terminal_failed_at desc;
 *
 * All four are partial-indexed on terminal_failed_at for that predicate.
 *
 * The same transition also increments the OpenTelemetry counter
 * `openbooks.terminal_failures` (tagged by surface/kind — see telemetry.ts), so
 * an operator with a collector can page on any increase instead of polling
 * these queries; when no OTel SDK is registered that increment is a free no-op
 * and the stamped rows remain the durable record.
 */
import { recordTerminalFailure } from "./telemetry.ts";

export const TERMINAL_FAILURE_LOG_EVENT = "scheduler.terminal_failure";

/** System identities recorded in `terminal_failed_by`. */
export const SCHEDULER_OUTBOX_WORKER_IDENTITY = "scheduler-outbox-worker";
export const REPORT_RUN_WORKER_IDENTITY = "report-run-worker";
export const EMAIL_DELIVERY_WORKER_IDENTITY = "email-delivery-worker";
export const POSTING_EFFECTS_WORKER_IDENTITY = "posting-effects-worker";

export type TerminalFailureLogFields = {
  surface:
    | "scheduler_outbox"
    | "report_runs"
    | "report_delivery_outbox"
    | "posting_effects";
  /** Outbox discriminator: dunning / subscription_billing / fx_providers / … */
  kind?: string;
  id: string;
  orgId: string | null;
  subjectId?: string | null;
  attempts: number;
  error: string;
  markedBy: string;
  at: Date;
};

/** Emit the operator signal for a poison row: the structured log line plus the
 * `openbooks.terminal_failures` metric increment. Best-effort by design — the
 * durable record is the stamped row, not these emissions. */
export function logTerminalFailure(fields: TerminalFailureLogFields): void {
  console.log(
    JSON.stringify({
      event: TERMINAL_FAILURE_LOG_EVENT,
      surface: fields.surface,
      kind: fields.kind ?? null,
      id: fields.id,
      orgId: fields.orgId,
      subjectId: fields.subjectId ?? null,
      attempts: fields.attempts,
      error: fields.error,
      markedBy: fields.markedBy,
      at: fields.at.toISOString(),
    }),
  );
  recordTerminalFailure(fields.surface, fields.kind);
}
