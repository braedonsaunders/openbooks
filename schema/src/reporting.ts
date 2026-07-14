import {
  boolean,
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

export const reportDefinitions = pgTable(
  "report_definitions",
  {
    id: id(),
    orgId: orgRef(),
    kind: text("kind", { enum: REPORT_DEFINITION_KINDS }).notNull().default("custom"),
    /** Stable per-org slug (built-ins keep their catalog slug; custom reports
     *  get a slugified name). Used for deep links and idempotent seeding. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /**
     * The ReportCustomQuery plan (@openbooks/reports types.ts): entity, mode,
     * columns, breakouts, measures, filters (nested and/or tree), sort, limit.
     * Validated by validateCustomQuery on every write.
     */
    query: jsonb("query").$type<Record<string, unknown>>().notNull(),
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
    ...auditColumns,
  },
  (t) => [
    index("report_runs_definition").on(t.definitionId, t.createdAt),
    index("report_runs_schedule").on(t.scheduleId),
    index("report_runs_org_status").on(t.orgId, t.status),
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
