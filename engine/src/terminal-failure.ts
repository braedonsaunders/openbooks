/**
 * Durable terminal-failure surfacing for the scheduler outboxes.
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
 * All three are partial-indexed on terminal_failed_at for that predicate.
 */
export const TERMINAL_FAILURE_LOG_EVENT = "scheduler.terminal_failure";

/** System identities recorded in `terminal_failed_by`. */
export const SCHEDULER_OUTBOX_WORKER_IDENTITY = "scheduler-outbox-worker";
export const REPORT_RUN_WORKER_IDENTITY = "report-run-worker";
export const EMAIL_DELIVERY_WORKER_IDENTITY = "email-delivery-worker";

export type TerminalFailureLogFields = {
  surface: "scheduler_outbox" | "report_runs" | "report_delivery_outbox";
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

/** Emit the one-line operator signal for a poison row. Best-effort by design: the durable record is the stamped row, not this line. */
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
}
