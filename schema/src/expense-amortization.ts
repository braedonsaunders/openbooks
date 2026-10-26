import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accounts } from "./coa";
import { classes, departments, locations, projects } from "./core";
import { documentLines, documents } from "./documents";
import { journalEntries } from "./ledger";
import { subsidiaries } from "./subsidiaries";
import { auditColumns, id, money, orgRef } from "./helpers";

/**
 * Expense amortization: prepaid and deferred expenses held in a deferral
 * (prepaid) account and released to expense by a monthly plan.
 *
 * Templates are effective-dated policy versions: the version in effect on
 * the source transaction date governs, and a version in use keeps its
 * policy fixed (migration 0687 guard), so a policy change is a new version
 * and never reinterprets history. Document lines name a template through
 * document_lines.amortization_template_id; that foreign key lives in the
 * migration so this file does not cycle back into documents.ts.
 *
 * A schedule snapshots the template's method and accounts, the posted
 * deferral amount, its entity, book, currency and dimensions. Its plan lines
 * post exactly once each; posted, superseded and cancelled lines and the
 * event history are immutable.
 */

export const EXPENSE_AMORTIZATION_METHODS = [
  "straight_line",
  "prorated_first_last",
  "exact_days",
  "variable",
] as const;
export const EXPENSE_AMORTIZATION_TERM_SOURCES = ["template", "service_dates"] as const;
export const EXPENSE_AMORTIZATION_SCHEDULE_STATUSES = [
  "draft",
  "active",
  "on_hold",
  "completed",
  "cancelled",
] as const;
export const EXPENSE_AMORTIZATION_SOURCE_KINDS = [
  "vendor_bill",
  "journal",
  "expense_report",
  "manual",
] as const;
export const EXPENSE_AMORTIZATION_LINE_STATUSES = [
  "planned",
  "posted",
  "superseded",
  "cancelled",
] as const;
export const EXPENSE_AMORTIZATION_EVENT_KINDS = [
  "created",
  "activated",
  "held",
  "resumed",
  "term_changed",
  "destination_changed",
  "reduced",
  "cancelled",
  "source_voided",
  "completed",
] as const;

export const expenseAmortizationTemplates = pgTable(
  "expense_amortization_templates",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    effectiveFrom: date("effective_from").notNull(),
    method: text("method", { enum: EXPENSE_AMORTIZATION_METHODS }).notNull(),
    termSource: text("term_source", { enum: EXPENSE_AMORTIZATION_TERM_SOURCES }).notNull(),
    periodCount: integer("period_count"),
    /** Variable method only: one exact percentage string per period, summing to 100. */
    percentages: jsonb("percentages"),
    deferralAccountId: uuid("deferral_account_id").notNull(),
    /** Null amortizes to the source line's own account. */
    destinationAccountId: uuid("destination_account_id"),
    periodOffset: integer("period_offset").notNull().default(0),
    rounding: text("rounding", { enum: ["remainder_last_period"] })
      .notNull()
      .default("remainder_last_period"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("expense_amortization_templates_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("expense_amortization_templates_code_version").on(t.orgId, t.code, t.effectiveFrom),
    check("expense_amortization_templates_offset_check", sql`${t.periodOffset} BETWEEN 0 AND 120`),
    foreignKey({
      name: "expense_amortization_templates_deferral_account_fkey",
      columns: [t.orgId, t.deferralAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
    foreignKey({
      name: "expense_amortization_templates_destination_account_fkey",
      columns: [t.orgId, t.destinationAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
  ],
);

export const expenseAmortizationSchedules = pgTable(
  "expense_amortization_schedules",
  {
    id: id(),
    orgId: orgRef(),
    scheduleNumber: text("schedule_number").notNull(),
    status: text("status", { enum: EXPENSE_AMORTIZATION_SCHEDULE_STATUSES }).notNull(),
    sourceKind: text("source_kind", { enum: EXPENSE_AMORTIZATION_SOURCE_KINDS }).notNull(),
    sourceDocumentId: uuid("source_document_id"),
    sourceLineId: uuid("source_line_id"),
    sourceEntryId: uuid("source_entry_id"),
    templateId: uuid("template_id").notNull(),
    method: text("method", { enum: EXPENSE_AMORTIZATION_METHODS }).notNull(),
    termSource: text("term_source", { enum: EXPENSE_AMORTIZATION_TERM_SOURCES }).notNull(),
    periodOffset: integer("period_offset").notNull(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    bookId: uuid("book_id").notNull(),
    /** Functional currency of the schedule's entity: amounts are ledger amounts. */
    currency: text("currency").notNull(),
    totalAmount: money("total_amount").notNull(),
    /** Amortized before the schedule was recorded (opening balances). */
    openingAmortizedAmount: money("opening_amortized_amount").notNull().default("0"),
    /** Posted amortization returned to the deferral account by catch-up reversals. */
    reversedAmount: money("reversed_amount").notNull().default("0"),
    serviceStartOn: date("service_start_on").notNull(),
    serviceEndOn: date("service_end_on").notNull(),
    firstPeriodOn: date("first_period_on").notNull(),
    deferralAccountId: uuid("deferral_account_id").notNull(),
    destinationAccountId: uuid("destination_account_id").notNull(),
    departmentId: uuid("department_id"),
    projectId: uuid("project_id"),
    locationId: uuid("location_id"),
    classId: uuid("class_id"),
    extraDims: jsonb("extra_dims").notNull().default({}),
    memo: text("memo"),
    holdReason: text("hold_reason"),
    /** Compare-and-set token: every change advances it by exactly one. */
    revision: integer("revision").notNull().default(1),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("expense_amortization_schedules_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("expense_amortization_schedules_number_unique").on(t.orgId, t.scheduleNumber),
    uniqueIndex("expense_amortization_schedules_source_line")
      .on(t.orgId, t.sourceLineId, t.bookId)
      .where(sql`${t.sourceLineId} IS NOT NULL`),
    index("expense_amortization_schedules_status").on(t.orgId, t.status),
    index("expense_amortization_schedules_deferral").on(
      t.orgId,
      t.deferralAccountId,
      t.subsidiaryId,
    ),
    foreignKey({
      name: "expense_amortization_schedules_source_document_fkey",
      columns: [t.orgId, t.sourceDocumentId],
      foreignColumns: [documents.orgId, documents.id],
    }),
    foreignKey({
      name: "expense_amortization_schedules_source_line_fkey",
      columns: [t.orgId, t.sourceLineId],
      foreignColumns: [documentLines.orgId, documentLines.id],
    }),
    foreignKey({
      name: "expense_amortization_schedules_source_entry_fkey",
      columns: [t.orgId, t.sourceEntryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
    }),
    foreignKey({
      name: "expense_amortization_schedules_template_fkey",
      columns: [t.orgId, t.templateId],
      foreignColumns: [expenseAmortizationTemplates.orgId, expenseAmortizationTemplates.id],
    }),
    foreignKey({
      name: "expense_amortization_schedules_subsidiary_fkey",
      columns: [t.orgId, t.subsidiaryId],
      foreignColumns: [subsidiaries.orgId, subsidiaries.id],
    }),
    foreignKey({
      name: "expense_amortization_schedules_deferral_account_fkey",
      columns: [t.orgId, t.deferralAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
    foreignKey({
      name: "expense_amortization_schedules_destination_account_fkey",
      columns: [t.orgId, t.destinationAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
    foreignKey({
      name: "expense_amortization_schedules_department_fkey",
      columns: [t.orgId, t.departmentId],
      foreignColumns: [departments.orgId, departments.id],
    }),
    foreignKey({
      name: "expense_amortization_schedules_project_fkey",
      columns: [t.orgId, t.projectId],
      foreignColumns: [projects.orgId, projects.id],
    }),
    foreignKey({
      name: "expense_amortization_schedules_location_fkey",
      columns: [t.orgId, t.locationId],
      foreignColumns: [locations.orgId, locations.id],
    }),
    foreignKey({
      name: "expense_amortization_schedules_class_fkey",
      columns: [t.orgId, t.classId],
      foreignColumns: [classes.orgId, classes.id],
    }),
  ],
);

export const expenseAmortizationScheduleLines = pgTable(
  "expense_amortization_schedule_lines",
  {
    id: id(),
    orgId: orgRef(),
    scheduleId: uuid("schedule_id").notNull(),
    planRevision: integer("plan_revision").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    /** The method weight the plan allocated by; kept so a re-forecast can reuse it. */
    weight: bigint("weight", { mode: "bigint" }).notNull(),
    plannedAmount: money("planned_amount").notNull(),
    destinationAccountId: uuid("destination_account_id").notNull(),
    status: text("status", { enum: EXPENSE_AMORTIZATION_LINE_STATUSES })
      .notNull()
      .default("planned"),
    journalEntryId: uuid("journal_entry_id"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    postedBy: uuid("posted_by"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
  },
  (t) => [
    uniqueIndex("expense_amortization_schedule_lines_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("expense_amortization_schedule_lines_live_period")
      .on(t.orgId, t.scheduleId, t.periodStart)
      .where(sql`${t.status} IN ('planned', 'posted')`),
    uniqueIndex("expense_amortization_schedule_lines_entry")
      .on(t.orgId, t.journalEntryId)
      .where(sql`${t.journalEntryId} IS NOT NULL`),
    index("expense_amortization_schedule_lines_due")
      .on(t.orgId, t.periodEnd)
      .where(sql`${t.status} = 'planned'`),
    foreignKey({
      name: "expense_amortization_schedule_lines_schedule_fkey",
      columns: [t.orgId, t.scheduleId],
      foreignColumns: [expenseAmortizationSchedules.orgId, expenseAmortizationSchedules.id],
    }),
    foreignKey({
      name: "expense_amortization_schedule_lines_account_fkey",
      columns: [t.orgId, t.destinationAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
    foreignKey({
      name: "expense_amortization_schedule_lines_entry_fkey",
      columns: [t.orgId, t.journalEntryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
    }),
  ],
);

export const expenseAmortizationScheduleEvents = pgTable(
  "expense_amortization_schedule_events",
  {
    id: id(),
    orgId: orgRef(),
    scheduleId: uuid("schedule_id").notNull(),
    kind: text("kind", { enum: EXPENSE_AMORTIZATION_EVENT_KINDS }).notNull(),
    effectivePeriodOn: date("effective_period_on"),
    /** Accounting date of the event's balance change. */
    effectiveOn: date("effective_on").notNull(),
    /** Change to the unamortized balance besides posted plan lines (signed). */
    balanceDelta: money("balance_delta").notNull().default("0"),
    reason: text("reason").notNull(),
    beforeState: jsonb("before_state"),
    afterState: jsonb("after_state").notNull(),
    journalEntryId: uuid("journal_entry_id"),
    relatedDocumentId: uuid("related_document_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
  },
  (t) => [
    uniqueIndex("expense_amortization_schedule_events_org_id_id_unique").on(t.orgId, t.id),
    index("expense_amortization_schedule_events_schedule").on(t.orgId, t.scheduleId, t.createdAt),
    foreignKey({
      name: "expense_amortization_schedule_events_schedule_fkey",
      columns: [t.orgId, t.scheduleId],
      foreignColumns: [expenseAmortizationSchedules.orgId, expenseAmortizationSchedules.id],
    }),
    foreignKey({
      name: "expense_amortization_schedule_events_entry_fkey",
      columns: [t.orgId, t.journalEntryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
    }),
  ],
);
