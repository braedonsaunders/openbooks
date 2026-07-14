import {
  boolean,
  date,
  index,
  integer,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, money, orgRef } from "./helpers";

/**
 * Revenue recognition, shaped by ASC 606 / IFRS 15:
 * contract → performance obligations → allocated price → recognition
 * schedule → period journals (origin = 'revenue_recognition').
 */

export const revenueContracts = pgTable(
  "revenue_contracts",
  {
    id: id(),
    orgId: orgRef(),
    customerId: uuid("customer_id").notNull(), // → parties
    contractNumber: text("contract_number").notNull(),
    status: text("status", { enum: ["draft", "active", "complete", "cancelled"] })
      .notNull()
      .default("draft"),
    startsOn: date("starts_on"),
    endsOn: date("ends_on"),
    totalTransactionPrice: money("total_transaction_price").notNull().default("0"),
    memo: text("memo"),
    ...auditColumns,
  },
  (t) => [index("rev_contracts_customer").on(t.customerId)],
);

export const recognitionRules = pgTable("recognition_rules", {
  id: id(),
  orgId: orgRef(),
  name: text("name").notNull(),
  method: text("method", {
    enum: ["point_in_time", "straight_line", "percent_complete", "usage", "milestone"],
  }).notNull(),
  /** Where deferred revenue sits until earned. */
  deferredAccountId: uuid("deferred_account_id").notNull(),
  recognizedAccountId: uuid("recognized_account_id").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  ...auditColumns,
});

/**
 * A distinct promise to the customer. Links back to the originating
 * document line(s); transaction price is allocated across obligations in
 * proportion to standalone selling price (SSP).
 */
export const performanceObligations = pgTable(
  "performance_obligations",
  {
    id: id(),
    orgId: orgRef(),
    contractId: uuid("contract_id").notNull(),
    documentLineId: uuid("document_line_id"),
    itemId: uuid("item_id"),
    description: text("description").notNull(),
    recognitionRuleId: uuid("recognition_rule_id").notNull(),
    standaloneSellingPrice: money("standalone_selling_price"),
    allocatedPrice: money("allocated_price").notNull(),
    percentComplete: money("percent_complete"), // for percent_complete method
    status: text("status", { enum: ["open", "satisfied", "cancelled"] })
      .notNull()
      .default("open"),
    ...auditColumns,
  },
  (t) => [index("obligations_contract").on(t.contractId)],
);

/**
 * The period-by-period plan. Each line recognizes into one period, in one
 * book; posting writes the journal entry id back — so recognized-to-date
 * is auditable and re-forecasting never touches posted lines.
 */
export const recognitionSchedules = pgTable(
  "recognition_schedules",
  {
    id: id(),
    orgId: orgRef(),
    obligationId: uuid("obligation_id").notNull(),
    bookId: uuid("book_id").notNull(),
    status: text("status", { enum: ["planned", "in_progress", "complete"] })
      .notNull()
      .default("planned"),
    totalAmount: money("total_amount").notNull(),
    ...auditColumns,
  },
  (t) => [index("rec_schedules_obligation").on(t.obligationId)],
);

export const recognitionScheduleLines = pgTable(
  "recognition_schedule_lines",
  {
    id: id(),
    orgId: orgRef(),
    scheduleId: uuid("schedule_id").notNull(),
    periodId: uuid("period_id").notNull(),
    sequence: integer("sequence").notNull(),
    plannedAmount: money("planned_amount").notNull(),
    recognizedAmount: money("recognized_amount"),
    journalEntryId: uuid("journal_entry_id"), // set when posted
    ...auditColumns,
  },
  (t) => [
    index("rec_lines_schedule").on(t.scheduleId),
    index("rec_lines_period").on(t.periodId),
  ],
);
