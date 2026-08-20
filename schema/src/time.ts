import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  auditColumns,
  currencyCode,
  fxRate,
  id,
  money,
  orgRef,
} from "./helpers";

/**
 * A weekly timesheet header — one row per employee per Sunday→Saturday week.
 *
 * The hours themselves stay in `time_entries`; this owns the WEEK as a record:
 * its lifecycle status and the stamps that make approval auditable (who
 * submitted, who approved, why it was returned). Two things need that.
 *
 * First, status was previously derived by aggregating every entry's status,
 * which cannot express a week that exists but is empty, and forces every
 * consumer to recompute the same fold. Second, an approval engine has to be
 * able to name what it is approving: flow runs, gates and locks all key their
 * subject by uuid, and a week assembled from a composite key has no id to give
 * them. This row supplies it.
 *
 * Tenant extension deliberately does NOT live here — org-defined timesheet
 * fields are line-level (`time_entries.custom`) and render as grid columns.
 */
export const timesheetWeeks = pgTable(
  "timesheet_weeks",
  {
    id: id(),
    orgId: orgRef(),
    employeePartyId: uuid("employee_party_id").notNull(),
    /** The week's Sunday. Weeks run Sunday→Saturday. */
    weekStart: date("week_start").notNull(),
    status: text("status", {
      enum: ["draft", "submitted", "approved", "rejected"],
    })
      .notNull()
      .default("draft"),
    submittedBy: uuid("submitted_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    approvedBy: uuid("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    /** The approver's note when the week was returned to the employee. */
    rejectionReason: text("rejection_reason"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("timesheet_weeks_employee_week").on(t.orgId, t.employeePartyId, t.weekStart),
    index("timesheet_weeks_status").on(t.orgId, t.status),
    check(
      "timesheet_weeks_week_start_is_sunday",
      sql`extract(dow from ${t.weekStart}) = 0`,
    ),
  ],
);

/**
 * Time entries — the atom of services job costing. Approved time flows
 * three ways: cost journals (labor + burden to project WIP/COGS), T&M
 * invoice lines (documentLines.timeEntryId provenance), and payroll export.
 */
export const timeEntries = pgTable(
  "time_entries",
  {
    id: id(),
    orgId: orgRef(),
    employeePartyId: uuid("employee_party_id").notNull(),
    workedOn: date("worked_on").notNull(),
    hours: money("hours").notNull(),
    /**
     * When the work on this entry STARTED, if the capture surface knows.
     *
     * The ordering fact, and nothing else. Several derived earnings are costed
     * to "the first job of the day" (travel pay:
     * engine/src/payroll-derived-earnings.ts), and with only `worked_on` to go
     * on "first" could be resolved from nothing better than the order the rows
     * were captured in — so a field app that uploads a day's rows out of order,
     * or a crew sheet keyed in job-by-job, costed travel to the wrong job with
     * no way to tell.
     *
     * NULLABLE deliberately: every row written before this column existed has
     * no clock time and must keep working, so the resolver prefers `started_at`
     * and falls back to capture order (`created_at`, then `id`) only where it is
     * null. It is never used to re-derive which DAY the work belongs to —
     * `worked_on` owns that, and a night shift crossing midnight would make any
     * derivation of it wrong.
     *
     * There is deliberately no `ended_at`. `hours` is the single source of truth
     * for duration — it is what payroll pays and what job costing costs — and an
     * `ended_at` that no code reads would be a second, unenforced answer to
     * "how long was this?" that could disagree with it. When a feature actually
     * needs the close of the shift (rest-period compliance, shift
     * differentials), it arrives with the check that keeps the two consistent.
     */
    startedAt: timestamp("started_at", { withTimezone: true }),
    timeTypeId: uuid("time_type_id"),
    itemId: uuid("item_id"), // billable service item
    projectId: uuid("project_id"),
    projectTaskId: uuid("project_task_id"),
    departmentId: uuid("department_id"),
    memo: text("memo"),
    memoIsPrivate: boolean("memo_is_private").notNull().default(false),
    isBillable: boolean("is_billable").notNull().default(false),
    costRate: money("cost_rate"), // snapshot at approval
    /** Audit provenance for a resolved multicurrency labor wage. */
    laborCostRateId: uuid("labor_cost_rate_id"),
    wageRate: money("wage_rate"),
    wageCurrency: currencyCode("wage_currency"),
    wageFxRate: fxRate("wage_fx_rate"),
    costRateCurrency: currencyCode("cost_rate_currency"),
    costRateSubsidiaryId: uuid("cost_rate_subsidiary_id"),
    billRate: money("bill_rate"),
    /** Bill-out provenance mirrors wage provenance: retain the negotiated
     * source amount/currency and the exact spot conversion used for the
     * project's functional currency. */
    billRateSourceRate: money("bill_rate_source_rate"),
    billRateSourceCurrency: currencyCode("bill_rate_source_currency"),
    billRateFxRate: fxRate("bill_rate_fx_rate"),
    billRateCurrency: currencyCode("bill_rate_currency"),
    billRateBookId: uuid("bill_rate_book_id"),
    billRateVersionId: uuid("bill_rate_version_id"),
    billRateLineId: uuid("bill_rate_line_id"),
    status: text("status", {
      enum: ["draft", "submitted", "approved", "rejected"],
    })
      .notNull()
      .default("draft"),
    approvedBy: uuid("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    /** Why an approver bounced this entry back. Kept on the row so the person
     * who has to fix it sees the reason, and so a rejection is a documented
     * decision rather than a silent status change. */
    rejectionReason: text("rejection_reason"),
    /**
     * The entry this one corrects. Once hours have been invoiced, paid or
     * costed they are evidence for a document that already exists, so the
     * correction is a new offsetting entry pointing back here — never an edit
     * of the original. Null for ordinary entries.
     */
    amendsEntryId: uuid("amends_entry_id"),
    /** Downstream linkage. */
    costJournalEntryId: uuid("cost_journal_entry_id"),
    /** The net-zero overhead pair that carried this entry's hours (stamped at
     * approval / backfill; overhead applies with the hours, never monthly). */
    overheadJournalEntryId: uuid("overhead_journal_entry_id"),
    /** The field ticket (documents kind 'field_ticket') this entry belongs to,
     * when hours were captured on a crew ticket rather than a personal week. */
    fieldTicketId: uuid("field_ticket_id"),
    /**
     * Commercial billing lifecycle is independent of invoice-line provenance.
     * Imported systems can prove that time was billed without exposing the
     * exact invoice line; OpenBooks-native billing also carries the link below.
     */
    billingStatus: text("billing_status", {
      enum: ["unbilled", "billed"],
    })
      .notNull()
      .default("unbilled"),
    /**
     * Whether this line's labor cost has been actualized into accounting.
     * Estimated lines remain valid commercial/project-planning evidence but
     * must not be confused with posted payroll labor.
     */
    costingBasis: text("costing_basis", {
      enum: ["actual", "estimated"],
    })
      .notNull()
      .default("actual"),
    invoicedByLineId: uuid("invoiced_by_line_id"),
    payrollBatchRef: text("payroll_batch_ref"),
    /** Keeps the source platform timebill nsId + source flags for the import bridge. */
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    index("time_entries_employee_date").on(t.employeePartyId, t.workedOn),
    index("time_entries_project").on(t.projectId, t.isBillable),
    index("time_entries_status").on(t.orgId, t.status),
    index("time_entries_billing_status").on(t.orgId, t.billingStatus),
    index("time_entries_costing_basis").on(
      t.orgId,
      t.projectId,
      t.costingBasis,
    ),
  ],
);

/**
 * Project WBS — tasks under a project, for estimates vs actuals.
 *
 * This is also the SCHEDULED activity. The `schedule*` columns below carry the
 * critical-path plan (dates, outline, constraints, progress) for orgs with the
 * Project Scheduling feature on; they are simply null everywhere else. Keeping
 * the plan on the same row as the estimate means time entries, costs and the
 * schedule can never disagree about which task they refer to.
 */
export const projectTasks = pgTable(
  "project_tasks",
  {
    id: id(),
    orgId: orgRef(),
    projectId: uuid("project_id").notNull(),
    parentId: uuid("parent_id"),
    code: text("code"),
    name: text("name").notNull(),
    status: text("status", { enum: ["open", "complete", "cancelled"] })
      .notNull()
      .default("open"),
    estimatedHours: money("estimated_hours"),
    estimatedCost: money("estimated_cost"),

    // --- Scheduling (null unless the project is scheduled) ------------------
    description: text("description"),
    /** Bar, zero-duration marker, or a parent whose dates roll up. */
    scheduleTaskType: text("schedule_task_type", { enum: ["task", "milestone", "summary"] })
      .notNull()
      .default("task"),
    /**
     * Execution status of the PLAN. Deliberately separate from `status`, which
     * is the costing lifecycle (open/complete/cancelled) that estimates and
     * time entries key off.
     */
    scheduleStatus: text("schedule_status", {
      enum: ["not_started", "in_progress", "complete", "on_hold"],
    })
      .notNull()
      .default("not_started"),
    scheduleStart: date("schedule_start"),
    scheduleEnd: date("schedule_end"),
    scheduleDuration: integer("schedule_duration").notNull().default(0),
    /** 0–1 fraction. */
    scheduleProgress: numeric("schedule_progress", { precision: 5, scale: 4 })
      .notNull()
      .default("0"),
    /** Free-text owner label; capacity planning uses schedule_task_assignments. */
    scheduleAssignee: text("schedule_assignee"),
    /** Flat display sequence within the project. */
    scheduleOrder: integer("schedule_order").notNull().default(0),
    scheduleOutlineLevel: integer("schedule_outline_level").notNull().default(0),
    scheduleCalendarId: uuid("schedule_calendar_id"),
    schedulePhase: text("schedule_phase"),
    scheduleConstraintType: text("schedule_constraint_type", {
      enum: ["asap", "alap", "snet", "snlt", "fnet", "fnlt", "mso", "mfo"],
    })
      .notNull()
      .default("asap"),
    scheduleConstraintDate: date("schedule_constraint_date"),
    scheduleDeadlineDate: date("schedule_deadline_date"),
    scheduleActualStart: date("schedule_actual_start"),
    scheduleActualEnd: date("schedule_actual_end"),
    ...auditColumns,
  },
  (t) => [
    index("project_tasks_project").on(t.projectId),
    index("project_tasks_schedule_order").on(t.orgId, t.projectId, t.scheduleOrder),
  ],
);

/**
 * Recurring document generation (rent bills, subscription invoices,
 * standing journals): a template document (status stays draft, flagged
 * here) plus a cadence.
 */
export const recurringSchedules = pgTable(
  "recurring_schedules",
  {
    id: id(),
    orgId: orgRef(),
    templateDocumentId: uuid("template_document_id").notNull(),
    cadence: text("cadence", {
      enum: [
        "weekly",
        "biweekly",
        "monthly",
        "quarterly",
        "annually",
        "custom_cron",
      ],
    }).notNull(),
    cron: text("cron"), // for custom_cron
    nextRunOn: date("next_run_on").notNull(),
    endsOn: date("ends_on"),
    autoPost: boolean("auto_post").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    /** Human label for the schedule list (falls back to the template's number). */
    name: text("name"),
    /** How many documents this schedule has generated so far. */
    runCount: integer("run_count").notNull().default(0),
    /** The most recent document produced (for the UI's "last run" link). */
    lastDocumentId: uuid("last_document_id"),
    /** Non-null when the last tick failed, so the UI can surface it. */
    lastError: text("last_error"),
    ...auditColumns,
  },
  (t) => [index("recurring_next_run").on(t.isActive, t.nextRunOn)],
);
