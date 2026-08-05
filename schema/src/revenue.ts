import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, money, orgRef } from "./helpers";

/**
 * Revenue recognition, shaped by ASC 606 / IFRS 15 and source platform's Advanced
 * Revenue Management (ARM):
 *
 *   contract → performance obligations → allocated price (by SSP) →
 *   recognition schedule → period journals (origin = 'revenue_recognition').
 *
 * Everything a controller would tune is DATA, configured in the UI, not code:
 * recognition rules (method + date sources + offsets + accounts), standalone
 * selling prices (fair-value price lists), and per-item defaults. The engine
 * (engine/src/revenue-recognition.ts) reads this config; posting always runs
 * through the kernel so deferred-revenue GL balance = Σ unrecognized plan.
 */

/**
 * How a rule spreads an obligation's allocated amount across periods.
 * Mirrors source platform ARM recognition methods.
 */
export const RECOGNITION_METHODS = [
  "point_in_time", // recognize the whole amount on the start date
  "straight_line_even", // equal amount per period over the term
  "straight_line_prorate_first_last", // even, but first & last period prorated by days in service
  "straight_line_daily", // exact days: each period gets (days in period / total days)
  "percent_complete", // recognize cumulative % (project/manual) − already recognized
  "milestone", // recognize only when a milestone/event fires (amounts entered per event)
  "usage", // recognize per unit consumed × unit rate (usage events)
] as const;

/** Where the recognition term starts / ends when the rule is term-driven. */
export const START_DATE_SOURCES = ["obligation", "document", "fulfillment", "event", "contract"] as const;
export const END_DATE_SOURCES = ["term", "obligation", "contract"] as const;

/**
 * A revenue recognition rule — the reusable, org-configured recipe applied to an
 * obligation. Actual rules post; forecast rules only project (isForecast).
 */
export const recognitionRules = pgTable(
  "recognition_rules",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    method: text("method", { enum: RECOGNITION_METHODS }).notNull(),
    /** Forecast rules feed the pipeline/forecast only; they never post GL. */
    isForecast: boolean("is_forecast").notNull().default(false),
    /** Term length in accounting periods (months) when not purely date-driven. */
    recognitionPeriods: integer("recognition_periods"),
    /** Term boundaries. `document`/`fulfillment`/`event` resolve at plan time. */
    startDateSource: text("start_date_source", { enum: START_DATE_SOURCES }).notNull().default("obligation"),
    endDateSource: text("end_date_source", { enum: END_DATE_SOURCES }).notNull().default("term"),
    /** Shift the whole schedule by N periods (deferral) — source platform "period offset". */
    periodOffset: integer("period_offset").notNull().default(0),
    /** Shift the start date by N days before spreading. */
    startOffsetDays: integer("start_offset_days").notNull().default(0),
    /** Percent recognized immediately in the first period (e.g. an activation fee). */
    initialAmountPercent: money("initial_amount_percent").notNull().default("0"),
    /** Where unearned revenue sits until recognized, and where it lands when earned.
     *  Item / obligation overrides win; these are the rule-level defaults. */
    deferredAccountId: uuid("deferred_account_id"),
    recognizedAccountId: uuid("recognized_account_id"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [uniqueIndex("recognition_rules_org_code").on(t.orgId, t.code)],
);

/**
 * Standalone selling price (fair value) for an item, used to allocate a bundle's
 * transaction price across obligations (relative-SSP method). Dated + currency
 * scoped; low/high bound the acceptable range for allocation review.
 * source platform's "Fair Value Price" list, native.
 */
export const fairValuePrices = pgTable(
  "fair_value_prices",
  {
    id: id(),
    orgId: orgRef(),
    itemId: uuid("item_id").notNull(),
    currency: text("currency").notNull(),
    unitPrice: money("unit_price").notNull(),
    lowValue: money("low_value"),
    highValue: money("high_value"),
    effectiveFrom: date("effective_from"),
    effectiveTo: date("effective_to"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [index("fair_value_item").on(t.itemId, t.currency, t.effectiveFrom)],
);

export const revenueContracts = pgTable(
  "revenue_contracts",
  {
    id: id(),
    orgId: orgRef(),
    customerId: uuid("customer_id").notNull(), // → parties
    /** Set when the contract IS a fixed-price project's revenue contract
     *  (percent-complete over-time recognition); null for invoice bundles. */
    projectId: uuid("project_id"),
    contractNumber: text("contract_number").notNull(),
    status: text("status", { enum: ["draft", "active", "complete", "cancelled"] })
      .notNull()
      .default("draft"),
    startsOn: date("starts_on"),
    endsOn: date("ends_on"),
    totalTransactionPrice: money("total_transaction_price").notNull().default("0"),
    /**
     * ASC 606 step-3 pricing evidence: fixed consideration, the variable-
     * consideration estimate and its constraint (606-10-32-11 / IFRS 15.56),
     * and any significant-financing-component split (606-10-32-15 /
     * IFRS 15.60). Written by the engine's contract-pricing service; the
     * resolved price lands in `total_transaction_price`.
     */
    pricing: jsonb("pricing").notNull().default({}),
    currency: text("currency"),
    memo: text("memo"),
    ...auditColumns,
  },
  (t) => [index("rev_contracts_customer").on(t.customerId), index("rev_contracts_project").on(t.projectId)],
);

/**
 * A distinct promise to the customer. Links back to the originating document
 * line; transaction price is allocated across obligations in proportion to
 * standalone selling price (SSP). `recognitionStartsOn/EndsOn` are the resolved
 * term the schedule is built over.
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
    /** Booked selling price on the line (what was billed) before allocation. */
    bookedAmount: money("booked_amount"),
    standaloneSellingPrice: money("standalone_selling_price"),
    /** Amount to recognize after relative-SSP allocation of the bundle. */
    allocatedPrice: money("allocated_price").notNull(),
    percentComplete: money("percent_complete"), // for percent_complete method
    /** Fair-value range review (orgs.settings.revenue.fairValueRangePolicy):
     *  set when the allocated per-unit price falls outside the matched fair
     *  value price's [low, high]; the matched bounds are kept for display. */
    fairValueFlag: text("fair_value_flag", { enum: ["below_range", "above_range"] }),
    fairValueLow: money("fair_value_low"),
    fairValueHigh: money("fair_value_high"),
    recognitionStartsOn: date("recognition_starts_on"),
    recognitionEndsOn: date("recognition_ends_on"),
    /** Deferred/recognized account resolution: obligation → item → rule. */
    deferredAccountId: uuid("deferred_account_id"),
    recognizedAccountId: uuid("recognized_account_id"),
    status: text("status", { enum: ["open", "satisfied", "cancelled"] })
      .notNull()
      .default("open"),
    cancellationReason: text("cancellation_reason"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by"),
    ...auditColumns,
  },
  (t) => [index("obligations_contract").on(t.contractId), index("obligations_doc_line").on(t.documentLineId)],
);

/**
 * The period-by-period plan for one obligation on one book. Posting writes the
 * journal entry id back to each line — so recognized-to-date is auditable and
 * re-forecasting never touches posted lines (mirror of depreciation schedules).
 */
export const recognitionSchedules = pgTable(
  "recognition_schedules",
  {
    id: id(),
    orgId: orgRef(),
    obligationId: uuid("obligation_id").notNull(),
    bookId: uuid("book_id").notNull(),
    status: text("status", {
      enum: ["planned", "in_progress", "complete", "cancelled"],
    })
      .notNull()
      .default("planned"),
    totalAmount: money("total_amount").notNull(),
    ...auditColumns,
  },
  (t) => [uniqueIndex("rec_schedules_obligation_book").on(t.obligationId, t.bookId)],
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
    /** Exact compensating journal; the original journal id is never replaced. */
    reversalJournalEntryId: uuid("reversal_journal_entry_id"),
    ...auditColumns,
  },
  (t) => [
    index("rec_lines_schedule").on(t.scheduleId),
    index("rec_lines_period").on(t.periodId),
  ],
);
