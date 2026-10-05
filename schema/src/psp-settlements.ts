import {
  date,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, currencyCode, id, money, orgRef } from "./helpers";
/** Providers that support hosted customer payment acceptance (checkout + webhooks). */
export const PSP_ACCEPTANCE_PROVIDERS = [
  "stripe",
  "adyen",
  "gocardless",
] as const;

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
    /** Receipt bank; migration 0037 enforces tenant ownership and asset_bank
     *  postability before a link can be stored. */
    bankAccountId: uuid("bank_account_id").notNull(),
    /** Invoice open balance at link creation (re-derived at checkout). */
    amount: money("amount").notNull(),
    surchargeAmount: money("surcharge_amount").notNull().default("0"),
    currency: currencyCode("currency").notNull(),
    status: text("status", { enum: ["active", "paid", "void", "expired"] })
      .notNull()
      .default("active"),
    expiresOn: date("expires_on"),
    memo: text("memo"),
    paidPaymentDocumentId: uuid("paid_payment_document_id"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("payment_links_token").on(t.token),
    index("payment_links_doc").on(t.orgId, t.documentId, t.status),
  ],
);

/** Settlement provider kinds, widened by migration 0497 with Shopify Payments and PayPal. */
export const PSP_SETTLEMENT_PROVIDERS = [
  "stripe",
  "adyen",
  "gocardless",
  "recurly",
  "chargebee",
  "shopify_payments",
  "paypal",
] as const;

/**
 * Provider refund/dispute automation ledger: one row per provider event with
 * status history and posted documents. The customer links through the payment
 * attempt and receipt documents, never a party column.
 */
export const paymentDisputes = pgTable(
  "payment_disputes",
  {
    id: id(),
    orgId: orgRef(),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    kind: text("kind", { enum: ["refund", "dispute"] }).notNull(),
    status: text("status", {
      enum: ["pending_review", "posted", "rejected", "opened", "won", "lost"],
    }).notNull(),
    attemptId: uuid("attempt_id"),
    receiptDocumentId: uuid("receipt_document_id"),
    invoiceDocumentId: uuid("invoice_document_id"),
    currency: currencyCode("currency").notNull(),
    amount: money("amount").notNull(),
    feeAmount: money("fee_amount").notNull().default("0"),
    providerRef: text("provider_ref"),
    reason: text("reason"),
    statusHistory: jsonb("status_history").notNull().default([]),
    documentsPosted: jsonb("documents_posted").notNull().default([]),
    reviewedBy: uuid("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("payment_disputes_event_key").on(t.orgId, t.provider, t.providerEventId),
    index("payment_disputes_status").on(t.orgId, t.status),
    index("payment_disputes_attempt").on(t.orgId, t.attemptId),
  ],
);
