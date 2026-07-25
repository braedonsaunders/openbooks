import { boolean, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { auditColumns, currencyCode, id, money, orgRef } from "./helpers";

/**
 * Merchant/PSP settlement imports (Stripe, Recurly, Chargebee). A settlement
 * batch is the payout/deposit row from the processor; lines are fees, charges,
 * refunds, disputes, and FX adjustments that post through the kernel as a
 * single balanced journal (origin payment-ops style) with immutable evidence.
 */
export const pspSettlementBatches = pgTable(
  "psp_settlement_batches",
  {
    id: id(),
    orgId: orgRef(),
    provider: text("provider", { enum: ["stripe", "recurly", "chargebee"] }).notNull(),
    /** Provider payout / settlement id — unique per org for idempotent import. */
    externalRef: text("external_ref").notNull(),
    status: text("status", { enum: ["draft", "posted", "void"] }).notNull().default("draft"),
    currency: currencyCode().notNull(),
    /** Gross charges in settlement currency. */
    grossAmount: money("gross_amount").notNull().default("0"),
    feeAmount: money("fee_amount").notNull().default("0"),
    refundAmount: money("refund_amount").notNull().default("0"),
    disputeAmount: money("dispute_amount").notNull().default("0"),
    /** Net deposit to bank (often gross − fees − refunds ± FX). */
    netAmount: money("net_amount").notNull().default("0"),
    /** FX gain/loss recognized when processor settles in a different currency. */
    fxAmount: money("fx_amount").notNull().default("0"),
    settlementDate: date("settlement_date").notNull(),
    bankAccountId: uuid("bank_account_id"),
    feeAccountId: uuid("fee_account_id"),
    disputeAccountId: uuid("dispute_account_id"),
    fxAccountId: uuid("fx_account_id"),
    clearingAccountId: uuid("clearing_account_id"),
    subsidiaryId: uuid("subsidiary_id"),
    journalEntryId: uuid("journal_entry_id"),
    sourcePayload: jsonb("source_payload").$type<Record<string, unknown>>(),
    lineCount: integer("line_count").notNull().default(0),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    memo: text("memo"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("psp_settlement_batches_org_ext").on(t.orgId, t.provider, t.externalRef),
    index("psp_settlement_batches_org_date").on(t.orgId, t.settlementDate),
  ],
);

export const pspSettlementLines = pgTable(
  "psp_settlement_lines",
  {
    id: id(),
    orgId: orgRef(),
    batchId: uuid("batch_id").notNull(),
    lineNumber: integer("line_number").notNull(),
    kind: text("kind", {
      enum: ["charge", "refund", "fee", "dispute", "dispute_reversal", "fx_adjustment", "transfer", "other"],
    }).notNull(),
    externalRef: text("external_ref"),
    description: text("description"),
    amount: money("amount").notNull(),
    currency: currencyCode(),
    /** Optional link into AR open item / customer payment application. */
    partyId: uuid("party_id"),
    documentId: uuid("document_id"),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    ...auditColumns,
  },
  (t) => [index("psp_settlement_lines_batch").on(t.batchId), index("psp_settlement_lines_doc").on(t.documentId)],
);

export const pspProviderConfigs = pgTable(
  "psp_provider_configs",
  {
    id: id(),
    orgId: orgRef(),
    provider: text("provider", { enum: ["stripe", "recurly", "chargebee"] }).notNull(),
    displayName: text("display_name").notNull(),
    isEnabled: boolean("is_enabled").notNull().default(false),
    defaultBankAccountId: uuid("default_bank_account_id"),
    defaultFeeAccountId: uuid("default_fee_account_id"),
    defaultDisputeAccountId: uuid("default_dispute_account_id"),
    defaultFxAccountId: uuid("default_fx_account_id"),
    defaultClearingAccountId: uuid("default_clearing_account_id"),
    secrets: text("secrets"),
    lastImportAt: timestamp("last_import_at", { withTimezone: true }),
    lastError: text("last_error"),
    ...auditColumns,
  },
  (t) => [uniqueIndex("psp_provider_configs_org_provider").on(t.orgId, t.provider)],
);
