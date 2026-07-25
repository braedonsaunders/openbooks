import { boolean, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { auditColumns, currencyCode, id, money, orgRef } from "./helpers";

/**
 * Merchant/PSP settlement imports (Stripe, Recurly, Chargebee). A settlement
 * batch is the payout/deposit row from the processor; lines are fees, charges,
 * refunds, disputes, and FX adjustments that post through the kernel as a
 * single balanced journal (origin payment-ops style) with immutable evidence.
 */
export const PSP_PROVIDERS = ["stripe", "adyen", "gocardless", "recurly", "chargebee"] as const;
/** Providers that support hosted customer payment acceptance (checkout + webhooks). */
export const PSP_ACCEPTANCE_PROVIDERS = ["stripe", "adyen", "gocardless"] as const;

export const pspSettlementBatches = pgTable(
  "psp_settlement_batches",
  {
    id: id(),
    orgId: orgRef(),
    provider: text("provider", { enum: PSP_PROVIDERS }).notNull(),
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
    provider: text("provider", { enum: PSP_PROVIDERS }).notNull(),
    displayName: text("display_name").notNull(),
    isEnabled: boolean("is_enabled").notNull().default(false),
    defaultBankAccountId: uuid("default_bank_account_id"),
    defaultFeeAccountId: uuid("default_fee_account_id"),
    defaultDisputeAccountId: uuid("default_dispute_account_id"),
    defaultFxAccountId: uuid("default_fx_account_id"),
    defaultClearingAccountId: uuid("default_clearing_account_id"),
    secrets: text("secrets"),
    /** Customer payment acceptance (hosted checkout links) on/off. */
    acceptanceEnabled: boolean("acceptance_enabled").notNull().default(false),
    publishableKey: text("publishable_key"),
    /** Provider-specific extras (e.g. Adyen merchantAccount, GoCardless creditor id). */
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    surchargeRuleId: uuid("surcharge_rule_id"),
    lastImportAt: timestamp("last_import_at", { withTimezone: true }),
    lastError: text("last_error"),
    ...auditColumns,
  },
  (t) => [uniqueIndex("psp_provider_configs_org_provider").on(t.orgId, t.provider)],
);

/** Effective-dated customer payment surcharge (card/convenience fee) rules. */
export const paymentSurchargeRules = pgTable(
  "payment_surcharge_rules",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    calculation: text("calculation", { enum: ["percent", "fixed", "percent_plus_fixed"] }).notNull(),
    percent: money("percent"),
    fixedAmount: money("fixed_amount"),
    capAmount: money("cap_amount"),
    /** Income account the surcharge posts to on receipt. */
    feeIncomeAccountId: uuid("fee_income_account_id").notNull(),
    /** Null = every acceptance provider. */
    provider: text("provider", { enum: PSP_ACCEPTANCE_PROVIDERS }),
    paymentMethod: text("payment_method", { enum: ["all", "card", "bank_debit"] }).notNull().default("all"),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [index("payment_surcharge_rules_org").on(t.orgId, t.isActive, t.effectiveFrom)],
);

/**
 * Hosted payment links on posted customer invoices. `token` is a 192-bit
 * url-safe random bearer credential (possession-authenticated — the same
 * trust model as field-ticket signing tokens).
 */
export const paymentLinks = pgTable(
  "payment_links",
  {
    id: id(),
    orgId: orgRef(),
    token: text("token").notNull(),
    documentId: uuid("document_id").notNull(),
    partyId: uuid("party_id").notNull(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    provider: text("provider", { enum: PSP_ACCEPTANCE_PROVIDERS }).notNull(),
    bankAccountId: uuid("bank_account_id").notNull(),
    /** Invoice open balance at link creation (re-derived at checkout). */
    amount: money("amount").notNull(),
    surchargeAmount: money("surcharge_amount").notNull().default("0"),
    currency: currencyCode().notNull(),
    status: text("status", { enum: ["active", "paid", "void", "expired"] }).notNull().default("active"),
    expiresOn: date("expires_on"),
    memo: text("memo"),
    paidPaymentDocumentId: uuid("paid_payment_document_id"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [uniqueIndex("payment_links_token").on(t.token), index("payment_links_doc").on(t.orgId, t.documentId, t.status)],
);

/** One row per provider checkout attempt; (org, provider, externalRef) is the webhook idempotency key. */
export const paymentAttempts = pgTable(
  "payment_attempts",
  {
    id: id(),
    orgId: orgRef(),
    linkId: uuid("link_id").notNull(),
    provider: text("provider").notNull(),
    externalRef: text("external_ref").notNull(),
    status: text("status", { enum: ["initiated", "succeeded", "failed", "cancelled", "refunded"] })
      .notNull()
      .default("initiated"),
    amount: money("amount"),
    surchargeAmount: money("surcharge_amount"),
    feeAmount: money("fee_amount"),
    paymentDocumentId: uuid("payment_document_id"),
    journalEntryId: uuid("journal_entry_id"),
    eventPayload: jsonb("event_payload").$type<Record<string, unknown>>(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("payment_attempts_org_ext").on(t.orgId, t.provider, t.externalRef),
    index("payment_attempts_link").on(t.linkId),
  ],
);
