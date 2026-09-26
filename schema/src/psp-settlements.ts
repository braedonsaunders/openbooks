import {
  date,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
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
