import { sql } from "drizzle-orm";
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
import { auditColumns, id, money, orgRef } from "./helpers";

const quantity = (name: string) => numeric(name, { precision: 28, scale: 8 });
const createdColumns = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by"),
};

/**
 * Immutable snapshot of a project budget. Sequence 1 is the original (sold)
 * budget; later sequences are revised baselines. The working budget is the
 * project_tasks row; baselines are what it is measured against.
 */
export const projectBudgetBaselines = pgTable(
  "project_budget_baselines",
  {
    id: id(),
    orgId: orgRef(),
    projectId: uuid("project_id").notNull(),
    kind: text("kind", { enum: ["original", "revised"] }).notNull(),
    sequence: integer("sequence").notNull(),
    label: text("label").notNull(),
    reason: text("reason").notNull(),
    sourceDocumentId: uuid("source_document_id"),
    totalHours: quantity("total_hours").notNull().default("0"),
    totalCost: money("total_cost").notNull().default("0"),
    totalPrice: money("total_price").notNull().default("0"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("project_budget_baselines_sequence").on(t.orgId, t.projectId, t.sequence),
    check("project_budget_baselines_original_first", sql`(${t.kind} = 'original') = (${t.sequence} = 1)`),
  ],
);

export const projectBudgetBaselineLines = pgTable(
  "project_budget_baseline_lines",
  {
    id: id(),
    orgId: orgRef(),
    baselineId: uuid("baseline_id").notNull(),
    projectId: uuid("project_id").notNull(),
    projectTaskId: uuid("project_task_id").notNull(),
    sequence: integer("sequence").notNull(),
    taskCode: text("task_code"),
    taskName: text("task_name").notNull(),
    sourceLineId: uuid("source_line_id"),
    itemId: uuid("item_id"),
    description: text("description"),
    hours: quantity("hours").notNull().default("0"),
    quantity: quantity("quantity"),
    unit: text("unit"),
    cost: money("cost").notNull().default("0"),
    price: money("price").notNull().default("0"),
    ...createdColumns,
  },
  (t) => [
    uniqueIndex("project_budget_baseline_lines_sequence").on(t.orgId, t.baselineId, t.sequence),
    index("project_budget_baseline_lines_task").on(t.orgId, t.projectTaskId),
  ],
);

/** Estimate-to-complete evidence per task; the latest row on or before a date governs. */
export const projectForecasts = pgTable(
  "project_forecasts",
  {
    id: id(),
    orgId: orgRef(),
    projectId: uuid("project_id").notNull(),
    projectTaskId: uuid("project_task_id").notNull(),
    asOfDate: date("as_of_date").notNull(),
    method: text("method", {
      enum: ["manual", "remaining_budget", "units_productivity", "cost_performance"],
    }).notNull(),
    costToComplete: money("cost_to_complete").notNull(),
    hoursToComplete: quantity("hours_to_complete"),
    note: text("note"),
    ...createdColumns,
  },
  (t) => [
    index("project_forecasts_project").on(t.orgId, t.projectId, t.asOfDate),
  ],
);

/** Append-only installed quantities; corrections append a reversing row. */
export const projectProgressEntries = pgTable(
  "project_progress_entries",
  {
    id: id(),
    orgId: orgRef(),
    projectId: uuid("project_id").notNull(),
    projectTaskId: uuid("project_task_id").notNull(),
    entryDate: date("entry_date").notNull(),
    quantity: quantity("quantity").notNull(),
    unit: text("unit").notNull(),
    source: text("source", { enum: ["manual", "field_ticket"] }).notNull(),
    sourceDocumentId: uuid("source_document_id"),
    reversesEntryId: uuid("reverses_entry_id"),
    note: text("note"),
    ...createdColumns,
  },
  (t) => [
    index("project_progress_entries_task_date").on(t.orgId, t.projectTaskId, t.entryDate),
    index("project_progress_entries_project_date").on(t.orgId, t.projectId, t.entryDate),
  ],
);

/** Production reported on a field ticket; approval records it as progress. */
export const fieldTicketQuantities = pgTable(
  "field_ticket_quantities",
  {
    id: id(),
    orgId: orgRef(),
    fieldTicketId: uuid("field_ticket_id").notNull(),
    projectTaskId: uuid("project_task_id").notNull(),
    quantity: quantity("quantity").notNull(),
    unit: text("unit").notNull(),
    note: text("note"),
    ...auditColumns,
  },
  (t) => [index("field_ticket_quantities_ticket").on(t.orgId, t.fieldTicketId)],
);

export const INTERNAL_BILLING_METHODS = ["revenue_credit", "cost_transfer", "intercompany_sale"] as const;
export type InternalBillingMethod = (typeof INTERNAL_BILLING_METHODS)[number];

/**
 * Effective-dated accounting treatment for internal billing: the receiving
 * side is debited, the providing side credited. One active version per code
 * per date.
 */
export const internalBillingRules = pgTable(
  "internal_billing_rules",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    method: text("method", { enum: INTERNAL_BILLING_METHODS }).notNull(),
    debitAccountId: uuid("debit_account_id").notNull(),
    creditAccountId: uuid("credit_account_id").notNull(),
    billableByDefault: boolean("billable_by_default").notNull().default(false),
    description: text("description"),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [index("internal_billing_rules_code").on(t.orgId, t.code, t.effectiveFrom)],
);

/** Accrued unbilled time-and-materials revenue with its next-period reversal. */
export const projectRevenueAccruals = pgTable(
  "project_revenue_accruals",
  {
    id: id(),
    orgId: orgRef(),
    runId: uuid("run_id").notNull(),
    projectId: uuid("project_id").notNull(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    periodId: uuid("period_id").notNull(),
    accrualDate: date("accrual_date").notNull(),
    reversalDate: date("reversal_date").notNull(),
    amount: money("amount").notNull(),
    currencyCode: text("currency_code").notNull(),
    unbilledAccountId: uuid("unbilled_account_id").notNull(),
    revenueAccountId: uuid("revenue_account_id").notNull(),
    accrualEntryId: uuid("accrual_entry_id").notNull(),
    reversalEntryId: uuid("reversal_entry_id").notNull(),
    basis: jsonb("basis").notNull().default({}),
    ...createdColumns,
  },
  (t) => [
    index("project_revenue_accruals_period").on(t.orgId, t.periodId, t.projectId),
    index("project_revenue_accruals_run").on(t.orgId, t.runId),
  ],
);
