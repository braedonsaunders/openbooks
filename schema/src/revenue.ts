import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid
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
 * (engine/src/revenue/recognition.ts) reads this config; posting always runs
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
    /** Effective-dated policy chain (0297): once a rule is referenced by any
     *  obligation, a policy edit creates a successor row instead of rewriting
     *  this one. Obligations pin their version through recognition_rule_id,
     *  so rebuilds and modification snapshots always read the pinned row.
     *  The self-reference is declared as a storage foreign key in 0297. */
    version: integer("version").notNull().default(1),
    supersededBy: uuid("superseded_by"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("recognition_rules_org_code")
      .on(t.orgId, t.code)
      .where(sql`${t.supersededBy} is null`),
    index("recognition_rules_superseded_by").on(t.supersededBy),
  ],
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
    /** Inclusive validity window. Active windows may not overlap within an
     *  item/currency identity (storage constraint 0051). */
    effectiveFrom: date("effective_from"),
    effectiveTo: date("effective_to"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [index("fair_value_item").on(t.itemId, t.currency, t.effectiveFrom)],
);

/**
 * What a revenue contract covers. Invoice scope is one contract per invoice
 * (the historical shape); order and subscription scopes accumulate every
 * billing of one sales order or subscription into a single contract, with
 * the contract asset/liability position netted across all of them.
 */
export const REVENUE_CONTRACT_SCOPES = ["invoice", "order", "subscription"] as const;

/**
 * A revenue contract (ASC 606 / IFRS 15): the commercial agreement behind
 * one or more billings. Scoped contracts accumulate billed consideration in
 * totalConsideration and record each billing in revenueContractBillings, so
 * recognized revenue can be presented net of billings per contract.
 */
export const revenueContracts = pgTable(
  "revenue_contracts",
  {
    id: id(),
    orgId: orgRef(),
    customerId: uuid("customer_id").notNull(),
    contractNumber: text("contract_number").notNull(),
    status: text("status").notNull().default("draft"),
    startsOn: date("starts_on"),
    endsOn: date("ends_on"),
    totalTransactionPrice: money("total_transaction_price").notNull().default("0"),
    memo: text("memo"),
    currency: text("currency"),
    projectId: uuid("project_id"),
    pricing: jsonb("pricing").notNull().default({}),
    subsidiaryId: uuid("subsidiary_id"),
    revision: integer("revision").notNull().default(1),
    lastChangeId: uuid("last_change_id"),
    parentContractId: uuid("parent_contract_id"),
    idempotencyKey: text("idempotency_key"),
    scope: text("scope", { enum: REVENUE_CONTRACT_SCOPES }).notNull().default("invoice"),
    sourceDocumentId: uuid("source_document_id"),
    subscriptionId: uuid("subscription_id"),
    /** Billed consideration accumulated across every billing of this contract. */
    totalConsideration: money("total_consideration").notNull().default("0"),
    /** Count of billings after the one that created the contract. */
    modificationSeq: integer("modification_seq").notNull().default(0),
    ...auditColumns,
  },
  (t) => [
    index("revenue_contracts_org_scope").on(t.orgId, t.scope),
    index("revenue_contracts_source_document").on(t.orgId, t.sourceDocumentId),
    index("revenue_contracts_subscription").on(t.orgId, t.subscriptionId),
  ],
);

/**
 * The billed leg of a revenue contract: one row per billing document posted
 * against the contract. Recognized revenue in excess of these billings is a
 * contract asset; billings in excess of recognized revenue are a contract
 * liability, netted per contract at period end.
 */
export const revenueContractBillings = pgTable(
  "revenue_contract_billings",
  {
    id: id(),
    orgId: orgRef(),
    contractId: uuid("contract_id").notNull(),
    documentId: uuid("document_id").notNull(),
    amount: money("amount").notNull(),
    billedOn: date("billed_on").notNull(),
    ...auditColumns,
  },
  (t) => [
    index("revenue_contract_billings_contract").on(t.orgId, t.contractId),
    uniqueIndex("revenue_contract_billings_document_unique").on(t.orgId, t.documentId),
  ],
);
