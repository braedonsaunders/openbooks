import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id } from "./helpers";

/**
 * Durable scheduler/approval-escalation outbox. Redis/BullMQ may rebuild from
 * these rows; they are never the source of truth. A crash mid-scan leaves a
 * claimed or failed row with a reason that operators can still read.
 */
export const SCHEDULER_OUTBOX_KINDS = [
  "dunning",
  "subscription_billing",
  "property_billing",
  "fx_providers",
  "approval_escalation",
] as const;
export const SCHEDULER_OUTBOX_SCAN_KINDS = [
  "dunning",
  "subscription_billing",
  "property_billing",
  "fx_providers",
] as const;
export const SCHEDULER_OUTBOX_STATUSES = ["pending", "running", "succeeded", "failed"] as const;

export const schedulerOutbox = pgTable(
  "scheduler_outbox",
  {
    id: id(),
    /** Null for platform-wide scans; required for per-gate escalations. */
    orgId: uuid("org_id"),
    kind: text("kind", { enum: SCHEDULER_OUTBOX_KINDS }).notNull(),
    /** Gate id for approval_escalation; null for scans. */
    subjectId: uuid("subject_id"),
    /** Singleton scan key (`dunning`) or the gate id for an escalation. */
    occurrenceKey: text("occurrence_key").notNull(),
    status: text("status", { enum: SCHEDULER_OUTBOX_STATUSES }).notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    /**
     * Stamped exactly once, by the attempt whose failure exhausts the retry
     * ceiling. Null on rows that are still cycling through backoff, which is
     * what lets operators alert on poison work without also alerting on every
     * transient failure (migration 0006_terminal_failure_surfacing).
     */
    terminalFailedAt: timestamp("terminal_failed_at", { withTimezone: true }),
    /** System identity of the worker attempt that recorded the terminal failure. */
    terminalFailedBy: text("terminal_failed_by"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("scheduler_outbox_occurrence").on(t.kind, t.occurrenceKey),
    index("scheduler_outbox_due").on(t.status, t.nextAttemptAt),
    index("scheduler_outbox_org").on(t.orgId, t.status, t.createdAt),
    index("scheduler_outbox_terminal_failed")
      .on(t.terminalFailedAt)
      .where(sql`${t.terminalFailedAt} is not null`),
    check(
      "scheduler_outbox_kind",
      sql`${t.kind} in ('dunning','subscription_billing','property_billing','fx_providers','approval_escalation')`,
    ),
    check("scheduler_outbox_status", sql`${t.status} in ('pending','running','succeeded','failed')`),
    check("scheduler_outbox_nonnegative_attempts", sql`${t.attemptCount} >= 0`),
    check(
      "scheduler_outbox_scope",
      sql`(
        (${t.kind} = 'approval_escalation' and ${t.orgId} is not null and ${t.subjectId} is not null)
        or (
          ${t.kind} in ('dunning','subscription_billing','property_billing','fx_providers')
          and ${t.orgId} is null and ${t.subjectId} is null
        )
      )`,
    ),
  ],
);
