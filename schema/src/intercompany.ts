import { sql } from "drizzle-orm";
import {
  boolean,
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
import { auditColumns, fxRate, id, money, orgRef } from "./helpers";

/**
 * Intercompany framework. Migrations 0685 and 0686 own the constraints and
 * guards; these definitions mirror the columns for typed reads.
 *
 * - Representing parties: the customer and vendor that represent an operating
 *   subsidiary to its sister entities. Their documents post through the
 *   intercompany receivable/payable accounts of the intercompany pair.
 * - Netting runs and lines: governed settlement of open intercompany balances
 *   as of a date, fingerprinted at proposal and posted unchanged.
 * - Fund transfers: bank movements between two entities' bank accounts.
 * - Transaction pairs: explicit links between a selling entity's sales
 *   document and the buying entity's purchase document.
 * - Transfer pricing policies: effective-dated intercompany prices.
 * - Fulfillment charges: lines one entity fulfilled from another's stock.
 */

export const INTERCOMPANY_NETTING_RUN_STATUSES = [
  "proposed",
  "pending_approval",
  "approved",
  "rejected",
  "posted",
  "cancelled",
  "reversed",
] as const;
export type IntercompanyNettingRunStatus = (typeof INTERCOMPANY_NETTING_RUN_STATUSES)[number];

export const INTERCOMPANY_NETTING_COMPONENTS = ["open_item", "due_position", "cash"] as const;
export type IntercompanyNettingComponent = (typeof INTERCOMPANY_NETTING_COMPONENTS)[number];

export const INTERCOMPANY_PAIR_KINDS = ["order", "invoice", "credit"] as const;
export type IntercompanyPairKind = (typeof INTERCOMPANY_PAIR_KINDS)[number];

export const INTERCOMPANY_TRANSFER_PRICING_METHODS = ["price_level", "cost_plus"] as const;
export type IntercompanyTransferPricingMethod =
  (typeof INTERCOMPANY_TRANSFER_PRICING_METHODS)[number];

export const intercompanyRepresentingParties = pgTable(
  "intercompany_representing_parties",
  {
    id: id(),
    orgId: orgRef(),
    /** The subsidiary these parties represent. */
    subsidiaryId: uuid("subsidiary_id").notNull(),
    customerPartyId: uuid("customer_party_id"),
    vendorPartyId: uuid("vendor_party_id"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("intercompany_representing_parties_one_per_subsidiary")
      .on(t.orgId, t.subsidiaryId)
      .where(sql`${t.isActive}`),
  ],
);

export const intercompanyNettingRuns = pgTable(
  "intercompany_netting_runs",
  {
    id: id(),
    orgId: orgRef(),
    runNumber: text("run_number").notNull(),
    asOfDate: date("as_of_date").notNull(),
    bookId: uuid("book_id").notNull(),
    periodId: uuid("period_id").notNull(),
    subsidiaryIds: uuid("subsidiary_ids").array().notNull(),
    settleCash: boolean("settle_cash").notNull().default(false),
    bankAccounts: jsonb("bank_accounts").notNull().default({}),
    status: text("status", { enum: INTERCOMPANY_NETTING_RUN_STATUSES })
      .notNull()
      .default("proposed"),
    computation: jsonb("computation").notNull(),
    fingerprint: text("fingerprint").notNull(),
    reason: text("reason").notNull(),
    idempotencyKey: text("idempotency_key"),
    flowRunId: uuid("flow_run_id"),
    decisionNote: text("decision_note"),
    proposedBy: uuid("proposed_by").notNull(),
    proposedAt: timestamp("proposed_at", { withTimezone: true }).notNull().defaultNow(),
    submittedBy: uuid("submitted_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    postedBy: uuid("posted_by"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    reversedBy: uuid("reversed_by"),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversalDate: date("reversal_date"),
    reverseReason: text("reverse_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("intercompany_netting_runs_number_unique").on(t.orgId, t.runNumber),
    index("intercompany_netting_runs_status").on(t.orgId, t.status, t.asOfDate),
  ],
);

export const intercompanyNettingLines = pgTable(
  "intercompany_netting_lines",
  {
    id: id(),
    orgId: orgRef(),
    runId: uuid("run_id").notNull(),
    lineNumber: integer("line_number").notNull(),
    pairId: uuid("pair_id").notNull(),
    currency: text("currency").notNull(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    counterpartySubsidiaryId: uuid("counterparty_subsidiary_id").notNull(),
    component: text("component", { enum: INTERCOMPANY_NETTING_COMPONENTS }).notNull(),
    accountId: uuid("account_id").notNull(),
    journalLineId: uuid("journal_line_id"),
    documentId: uuid("document_id"),
    functionalCurrency: text("functional_currency").notNull(),
    openTransactionAmount: money("open_transaction_amount").notNull().default("0"),
    openCarryingAmount: money("open_carrying_amount").notNull().default("0"),
    nettedAmount: money("netted_amount").notNull().default("0"),
    cashAmount: money("cash_amount").notNull().default("0"),
    settlementRate: fxRate("settlement_rate").notNull(),
    realizedFx: money("realized_fx").notNull().default("0"),
    settlementEntryId: uuid("settlement_entry_id"),
    settlementLineId: uuid("settlement_line_id"),
    applicationId: uuid("application_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("intercompany_netting_lines_number_unique").on(t.orgId, t.runId, t.lineNumber),
  ],
);

export const intercompanyFundTransfers = pgTable(
  "intercompany_fund_transfers",
  {
    id: id(),
    orgId: orgRef(),
    transferNumber: text("transfer_number").notNull(),
    transferDate: date("transfer_date").notNull(),
    fromSubsidiaryId: uuid("from_subsidiary_id").notNull(),
    toSubsidiaryId: uuid("to_subsidiary_id").notNull(),
    fromBankAccountId: uuid("from_bank_account_id").notNull(),
    toBankAccountId: uuid("to_bank_account_id").notNull(),
    currency: text("currency").notNull(),
    amount: money("amount").notNull(),
    memo: text("memo"),
    reason: text("reason").notNull(),
    entryId: uuid("entry_id").notNull(),
    status: text("status", { enum: ["posted", "reversed"] })
      .notNull()
      .default("posted"),
    idempotencyKey: text("idempotency_key"),
    reversalEntryId: uuid("reversal_entry_id"),
    reversalDate: date("reversal_date"),
    reverseReason: text("reverse_reason"),
    reversedBy: uuid("reversed_by"),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("intercompany_fund_transfers_number_unique").on(t.orgId, t.transferNumber)],
);

export const intercompanyTransactionPairs = pgTable(
  "intercompany_transaction_pairs",
  {
    id: id(),
    orgId: orgRef(),
    pairKind: text("pair_kind", { enum: INTERCOMPANY_PAIR_KINDS }).notNull(),
    sellerSubsidiaryId: uuid("seller_subsidiary_id").notNull(),
    buyerSubsidiaryId: uuid("buyer_subsidiary_id").notNull(),
    sellerDocumentId: uuid("seller_document_id").notNull(),
    buyerDocumentId: uuid("buyer_document_id").notNull(),
    origin: text("origin", { enum: ["generated", "linked"] }).notNull(),
    status: text("status", { enum: ["linked", "unlinked"] })
      .notNull()
      .default("linked"),
    linkReason: text("link_reason"),
    linkedBy: uuid("linked_by").notNull(),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
    unlinkedBy: uuid("unlinked_by"),
    unlinkedAt: timestamp("unlinked_at", { withTimezone: true }),
    unlinkReason: text("unlink_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("intercompany_transaction_pairs_live_seller")
      .on(t.orgId, t.sellerDocumentId)
      .where(sql`${t.status} = 'linked'`),
    uniqueIndex("intercompany_transaction_pairs_live_buyer")
      .on(t.orgId, t.buyerDocumentId)
      .where(sql`${t.status} = 'linked'`),
  ],
);

export const intercompanyTransferPricingPolicies = pgTable(
  "intercompany_transfer_pricing_policies",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    sellerSubsidiaryId: uuid("seller_subsidiary_id").notNull(),
    /** Null applies to every buying entity without its own policy. */
    buyerSubsidiaryId: uuid("buyer_subsidiary_id"),
    method: text("method", { enum: INTERCOMPANY_TRANSFER_PRICING_METHODS }).notNull(),
    priceLevelId: uuid("price_level_id"),
    markupPercent: numeric("markup_percent", { precision: 9, scale: 4 }),
    revenueAccountId: uuid("revenue_account_id").notNull(),
    costAccountId: uuid("cost_account_id").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    description: text("description"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("intercompany_transfer_pricing_policies_code_unique").on(t.orgId, t.code),
    index("intercompany_transfer_pricing_policies_lookup").on(
      t.orgId,
      t.sellerSubsidiaryId,
      t.effectiveFrom,
    ),
  ],
);

export const intercompanyFulfillmentCharges = pgTable(
  "intercompany_fulfillment_charges",
  {
    id: id(),
    orgId: orgRef(),
    kind: text("kind", { enum: ["fulfillment", "return"] }).notNull(),
    fulfillmentDocumentId: uuid("fulfillment_document_id").notNull(),
    fulfillmentLineId: uuid("fulfillment_line_id").notNull(),
    creditDocumentId: uuid("credit_document_id"),
    reversesChargeId: uuid("reverses_charge_id"),
    sellingSubsidiaryId: uuid("selling_subsidiary_id").notNull(),
    fulfillingSubsidiaryId: uuid("fulfilling_subsidiary_id").notNull(),
    policyId: uuid("policy_id").notNull(),
    itemId: uuid("item_id").notNull(),
    stockLocationId: uuid("stock_location_id").notNull(),
    movementId: uuid("movement_id").notNull(),
    quantity: numeric("quantity", { precision: 28, scale: 8 }).notNull(),
    costAmount: money("cost_amount").notNull(),
    costCurrency: text("cost_currency").notNull(),
    transferCurrency: text("transfer_currency").notNull(),
    transferUnitPrice: numeric("transfer_unit_price", { precision: 28, scale: 8 }).notNull(),
    transferAmount: money("transfer_amount").notNull(),
    entryId: uuid("entry_id").notNull(),
    chargeDate: date("charge_date").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
  },
  (t) => [
    uniqueIndex("intercompany_fulfillment_charges_movement_unique").on(t.orgId, t.movementId),
    index("intercompany_fulfillment_charges_fulfillment").on(t.orgId, t.fulfillmentDocumentId),
  ],
);
