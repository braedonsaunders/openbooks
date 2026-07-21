import {
  boolean,
  date,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, money, orgRef } from "./helpers";

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
    timeTypeId: uuid("time_type_id"),
    itemId: uuid("item_id"), // billable service item
    projectId: uuid("project_id"),
    projectTaskId: uuid("project_task_id"),
    departmentId: uuid("department_id"),
    locationId: uuid("location_id"),
    memo: text("memo"),
    memoIsPrivate: boolean("memo_is_private").notNull().default(false),
    isBillable: boolean("is_billable").notNull().default(false),
    /** Standard burdened cost and customer bill rate, snapshotted atomically at approval. */
    costRate: money("cost_rate"),
    billRate: money("bill_rate"),
    directCostRate: money("direct_cost_rate"),
    burdenRate: money("burden_rate"),
    transferRate: money("transfer_rate"),
    standardCostAmount: money("standard_cost_amount"),
    actualCostAmount: money("actual_cost_amount"),
    costVarianceAmount: money("cost_variance_amount"),
    costRateVersionId: uuid("cost_rate_version_id"),
    billRateVersionId: uuid("bill_rate_version_id"),
    rateResolvedAt: timestamp("rate_resolved_at", { withTimezone: true }),
    rateResolutionHash: text("rate_resolution_hash"),
    status: text("status", { enum: ["draft", "submitted", "approved", "rejected"] })
      .notNull()
      .default("draft"),
    approvedBy: uuid("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    /** Downstream linkage. */
    costJournalEntryId: uuid("cost_journal_entry_id"),
    invoicedByLineId: uuid("invoiced_by_line_id"),
    payrollBatchRef: text("payroll_batch_ref"),
    /** Keeps the NetSuite timebill nsId + source flags for the import bridge. */
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    index("time_entries_employee_date").on(t.employeePartyId, t.workedOn),
    index("time_entries_project").on(t.projectId, t.isBillable),
    index("time_entries_status").on(t.orgId, t.status),
  ],
);

/** Project WBS — tasks under a project, for estimates vs actuals. */
export const projectTasks = pgTable(
  "project_tasks",
  {
    id: id(),
    orgId: orgRef(),
    projectId: uuid("project_id").notNull(),
    parentId: uuid("parent_id"),
    code: text("code"),
    name: text("name").notNull(),
    status: text("status", { enum: ["open", "complete", "cancelled"] }).notNull().default("open"),
    estimatedHours: money("estimated_hours"),
    estimatedCost: money("estimated_cost"),
    ...auditColumns,
  },
  (t) => [index("project_tasks_project").on(t.projectId)],
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
    cadence: text("cadence", { enum: ["weekly", "biweekly", "monthly", "quarterly", "annually", "custom_cron"] }).notNull(),
    cron: text("cron"), // for custom_cron
    nextRunOn: date("next_run_on").notNull(),
    endsOn: date("ends_on"),
    autoPost: boolean("auto_post").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [index("recurring_next_run").on(t.isActive, t.nextRunOn)],
);
