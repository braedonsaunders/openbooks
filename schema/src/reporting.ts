import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

/**
 * Custom reporting — the report studio's persistence layer. Mirrors the query
 * plan / cadence types in @openbooks/reports; those TS types are the source of
 * truth and these jsonb columns carry structurally-identical shapes:
 *
 *   report_definitions (a saved/built-in report: entity + query plan + layout)
 *     └─ report_schedules (a recurring delivery of a definition to recipients)
 *          └─ report_runs (one execution — manual or scheduled — with its CSV)
 *
 * A run may be a bare manual execution of a definition (schedule_id null) or
 * the materialisation of a due schedule. The engine executor
 * (runCustomQuery) never touches these tables; the web layer records the run
 * row and stores the shaped result as CSV for download/audit.
 */

/** built_in = seeded by the platform (engine/src/seed-reports.ts); custom =
 *  authored by a user in the studio. Built-ins are cloneable, not deletable. */
export const REPORT_DEFINITION_KINDS = ["built_in", "custom"] as const;

/**
 * How a definition computes its result — the unification discriminator:
 *  - `query`     → the entity query engine (ReportCustomQuery in `query`).
 *  - `statement` → a standard financial statement (kind + params in `statement`),
 *    resolved through the matrix/statement engine. Standard reports (P&L, Balance
 *    Sheet, GL, …) are seeded as `statement` definitions so standard and custom
 *    reports share ONE model, run pipeline and (eventually) editor.
 */
export const REPORT_DEFINITION_TYPES = ["query", "statement"] as const;

export const reportDefinitions = pgTable(
  "report_definitions",
  {
    id: id(),
    orgId: orgRef(),
    kind: text("kind", { enum: REPORT_DEFINITION_KINDS }).notNull().default("custom"),
    /** query = entity-query report; statement = seeded standard financial statement. */
    reportType: text("report_type", { enum: REPORT_DEFINITION_TYPES }).notNull().default("query"),
    /** Stable per-org slug (built-ins keep their catalog slug; custom reports
     *  get a slugified name). Used for deep links and idempotent seeding. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /**
     * The ReportCustomQuery plan (@openbooks/reports types.ts): entity, mode,
     * columns, breakouts, measures, filters (nested and/or tree), sorts, limit.
     * Validated by validateCustomQuery on every write. NULL for `statement`
     * definitions, which carry their spec in `statement` instead.
     */
    query: jsonb("query").$type<Record<string, unknown>>(),
    /**
     * Statement spec for `report_type = 'statement'`: `{ kind, params? }` where
     * `kind` is a standard report kind (pnl, balance-sheet, general-ledger, …)
     * and `params` are its fixed args (e.g. { side: 'ar' }). NULL for `query`.
     */
    statement: jsonb("statement").$type<Record<string, unknown>>(),
    /** System-owned standard report: seeded + locked (edit ⇒ clone, not deletable). */
    system: boolean("system").notNull().default(false),
    /**
     * ReportLayoutConfig (paper/orientation/margins/density). Null ⇒ the
     * engine default (landscape Letter). Consumed when the print/PDF pipeline
     * lands (see @openbooks/reports resolveReportLayout).
     */
    layout: jsonb("layout").$type<Record<string, unknown>>(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("report_definitions_org_slug").on(t.orgId, t.slug),
    index("report_definitions_org_kind").on(t.orgId, t.kind),
  ],
);

/** Delivery cadence — mirrors @openbooks/reports ReportCadence. */
export const REPORT_SCHEDULE_CADENCES = ["daily", "weekly", "monthly"] as const;

export const reportSchedules = pgTable(
  "report_schedules",
  {
    id: id(),
    orgId: orgRef(),
    definitionId: uuid("definition_id").notNull(),
    cadence: text("cadence", { enum: REPORT_SCHEDULE_CADENCES }).notNull(),
    /** 0 = Sunday … 6 = Saturday. Required for weekly, null otherwise. */
    dayOfWeek: integer("day_of_week"),
    /** 1..31. Required for monthly, null otherwise. */
    dayOfMonth: integer("day_of_month"),
    hour: integer("hour").notNull().default(7),
    minute: integer("minute").notNull().default(0),
    /** IANA zone the hour/minute is interpreted in (e.g. 'America/Toronto'). */
    timezone: text("timezone").notNull().default("UTC"),
    /** Recipient email addresses (normalised/deduped by schedule-policy). */
    recipientEmails: jsonb("recipient_emails").$type<string[]>().notNull().default([]),
    /**
     * Optional extra filter overrides layered onto the definition's plan at
     * run time (a ReportRuleGroup fragment). Null ⇒ run the definition as-is.
     */
    filters: jsonb("filters").$type<Record<string, unknown>>(),
    /** Next UTC instant this schedule is due (computed via computeNextRunAt). */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    active: boolean("active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    index("report_schedules_definition").on(t.definitionId),
    // The worker seam scans active schedules whose next_run_at has passed.
    index("report_schedules_due").on(t.active, t.nextRunAt),
    index("report_schedules_org").on(t.orgId),
  ],
);

/** manual = "Run now" / preview; scheduled = materialised by the worker. */
export const REPORT_RUN_TRIGGERS = ["manual", "scheduled"] as const;
export const REPORT_RUN_STATUSES = ["queued", "running", "succeeded", "failed"] as const;

export const reportRuns = pgTable(
  "report_runs",
  {
    id: id(),
    orgId: orgRef(),
    /** Null for ad-hoc manual runs not tied to a schedule. */
    scheduleId: uuid("schedule_id"),
    definitionId: uuid("definition_id").notNull(),
    trigger: text("trigger", { enum: REPORT_RUN_TRIGGERS }).notNull().default("manual"),
    status: text("status", { enum: REPORT_RUN_STATUSES }).notNull().default("queued"),
    /** Populated on failure with the executor/validation error message. */
    error: text("error"),
    rowCount: integer("row_count"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** The shaped ReportRunResult serialised as CSV (reportResultToCsv), for
     *  download and audit. Null while queued/running or when a run failed. */
    resultCsv: text("result_csv"),
    /** Exact cadence occurrence and immutable delivery inputs for scheduled runs. */
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    recipientEmails: jsonb("recipient_emails").$type<string[]>().notNull().default([]),
    filters: jsonb("filters").$type<Record<string, unknown>>(),
    attemptCount: integer("attempt_count").notNull().default(0),
    dispatchCount: integer("dispatch_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    /**
     * Stamped exactly once, by the attempt whose failure exhausts the run
     * retry ceiling. Null while the run can still be retried, so operators
     * can alert on poison runs without noise from transient failures
     * (migration 0006_terminal_failure_surfacing).
     */
    terminalFailedAt: timestamp("terminal_failed_at", { withTimezone: true }),
    /** System identity of the worker attempt that recorded the terminal failure. */
    terminalFailedBy: text("terminal_failed_by"),
    ...auditColumns,
  },
  (t) => [
    index("report_runs_definition").on(t.definitionId, t.createdAt),
    index("report_runs_schedule").on(t.scheduleId),
    index("report_runs_org_status").on(t.orgId, t.status),
    index("report_runs_terminal_failed")
      .on(t.terminalFailedAt)
      .where(sql`${t.terminalFailedAt} is not null`),
    uniqueIndex("report_runs_schedule_occurrence")
      .on(t.scheduleId, t.scheduledFor)
      .where(sql`${t.scheduleId} is not null and ${t.scheduledFor} is not null`),
    check("report_runs_nonnegative_delivery_counts", sql`${t.attemptCount} >= 0 and ${t.dispatchCount} >= 0`),
  ],
);

/** Immutable rendered output retained as evidence independently of email. */
export const reportRunArtifacts = pgTable(
  "report_run_artifacts",
  {
    id: id(),
    orgId: orgRef(),
    runId: uuid("run_id").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    contentHash: text("content_hash").notNull(),
    bytes: bytea("bytes").notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("report_run_artifacts_run").on(t.runId),
    index("report_run_artifacts_org").on(t.orgId, t.createdAt),
    check("report_run_artifacts_positive_size", sql`${t.sizeBytes} > 0`),
    check("report_run_artifacts_sha256", sql`${t.contentHash} ~ '^[0-9a-f]{64}$'`),
    check("report_run_artifacts_pdf", sql`${t.contentType} = 'application/pdf'`),
  ],
);

export const REPORT_DELIVERY_STATUSES = ["pending", "enqueued", "sending", "sent", "failed", "suppressed"] as const;

/** Transactional per-recipient delivery outbox and final provider evidence. */
export const reportDeliveryOutbox = pgTable(
  "report_delivery_outbox",
  {
    id: id(),
    orgId: orgRef(),
    runId: uuid("run_id").notNull(),
    recipient: text("recipient").notNull(),
    status: text("status", { enum: REPORT_DELIVERY_STATUSES }).notNull().default("pending"),
    dispatchCount: integer("dispatch_count").notNull().default(0),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    queueJobId: text("queue_job_id"),
    emailLogId: uuid("email_log_id"),
    providerMessageId: text("provider_message_id"),
    error: text("error"),
    /**
     * Stamped exactly once when the queue gave up and attempt_count has also
     * reached the delivery ceiling — after that no path re-enqueues the row.
     * The operator alert query keys on this column
     * (migration 0006_terminal_failure_surfacing).
     */
    terminalFailedAt: timestamp("terminal_failed_at", { withTimezone: true }),
    /** System identity of the worker attempt that recorded the terminal failure. */
    terminalFailedBy: text("terminal_failed_by"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("report_delivery_outbox_run_recipient").on(t.runId, t.recipient),
    index("report_delivery_outbox_due").on(t.status, t.nextAttemptAt),
    index("report_delivery_outbox_org").on(t.orgId, t.createdAt),
    index("report_delivery_outbox_terminal_failed")
      .on(t.terminalFailedAt)
      .where(sql`${t.terminalFailedAt} is not null`),
    check("report_delivery_outbox_status", sql`${t.status} in ('pending','enqueued','sending','sent','failed','suppressed')`),
    check("report_delivery_outbox_nonnegative_counts", sql`${t.dispatchCount} >= 0 and ${t.attemptCount} >= 0`),
    check("report_delivery_outbox_recipient", sql`length(btrim(${t.recipient})) > 3`),
  ],
);

/*
FOREIGN KEYS (added by the integrator's migration pass to
schema/migrations/referential-integrity.sql):
  report_definitions.org_id             → orgs.id
  report_definitions.created_by         → users.id
  report_definitions.updated_by         → users.id
  report_schedules.org_id               → orgs.id
  report_schedules.definition_id        → report_definitions.id ON DELETE CASCADE
  report_schedules.created_by           → users.id
  report_schedules.updated_by           → users.id
  report_runs.org_id                    → orgs.id
  report_runs.schedule_id               → report_schedules.id ON DELETE SET NULL
  report_runs.definition_id             → report_definitions.id ON DELETE CASCADE
  report_runs.created_by                → users.id
  report_runs.updated_by                → users.id
*/
