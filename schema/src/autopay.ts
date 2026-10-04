import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, money, orgRef } from "./helpers";

/**
 * Stored customer payment methods (card on file, bank-debit mandate).
 * Provider tokens only — no card numbers are ever stored.
 */
export const customerPaymentMethods = pgTable(
  "customer_payment_methods",
  {
    id: id(),
    orgId: orgRef(),
    partyId: uuid("party_id").notNull(),
    provider: text("provider", { enum: ["stripe", "adyen", "gocardless"] }).notNull(),
    providerCustomerId: text("provider_customer_id"),
    providerMethodId: text("provider_method_id"),
    brand: text("brand"),
    last4: text("last4"),
    expMonth: smallint("exp_month"),
    expYear: smallint("exp_year"),
    mandateReference: text("mandate_reference"),
    isDefault: boolean("is_default").notNull().default(false),
    status: text("status", { enum: ["pending", "active", "removed"] }).notNull().default("active"),
    ...auditColumns,
  },
  (t) => [
    // One default method per customer: the scan charges the default, so two
    // defaults would make the charge target ambiguous.
    uniqueIndex("customer_payment_methods_one_default")
      .on(t.orgId, t.partyId)
      .where(sql`is_default`),
    index("customer_payment_methods_org_party").on(t.orgId, t.partyId),
  ],
);

/** Autopay enrollment: customer scope, or one subscription's own method. */
export const autopayEnrollments = pgTable(
  "autopay_enrollments",
  {
    id: id(),
    orgId: orgRef(),
    partyId: uuid("party_id").notNull(),
    subscriptionId: uuid("subscription_id"),
    paymentMethodId: uuid("payment_method_id"),
    status: text("status", { enum: ["active", "paused", "canceled"] }).notNull().default("active"),
    chargeOnIssue: boolean("charge_on_issue").notNull().default(false),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("autopay_enrollments_one_customer")
      .on(t.orgId, t.partyId)
      .where(sql`subscription_id is null and status = 'active'`),
    uniqueIndex("autopay_enrollments_one_subscription")
      .on(t.orgId, t.subscriptionId)
      .where(sql`subscription_id is not null and status = 'active'`),
    index("autopay_enrollments_org_party").on(t.orgId, t.partyId),
  ],
);

/**
 * One automatic collection charge per (invoice, retry position). The row id
 * is the provider idempotency key, so a retried tick reuses the attempt
 * instead of charging twice.
 */
export const collectionAttempts = pgTable(
  "collection_attempts",
  {
    id: id(),
    orgId: orgRef(),
    invoiceId: uuid("invoice_id").notNull(),
    enrollmentId: uuid("enrollment_id"),
    paymentMethodId: uuid("payment_method_id"),
    amount: money("amount").notNull(),
    currency: text("currency").notNull(),
    provider: text("provider", { enum: ["stripe", "adyen", "gocardless"] }).notNull(),
    providerRef: text("provider_ref"),
    receiptDocumentId: uuid("receipt_document_id"),
    status: text("status", {
      enum: ["initiated", "processing", "succeeded", "failed", "canceled"],
    })
      .notNull()
      .default("initiated"),
    declineCode: text("decline_code"),
    declineKind: text("decline_kind", { enum: ["hard", "soft"] }),
    retryPosition: integer("retry_position").notNull().default(0),
    nextRetryOn: date("next_retry_on"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("collection_attempts_one_per_position").on(t.orgId, t.invoiceId, t.retryPosition),
    index("collection_attempts_org_invoice").on(t.orgId, t.invoiceId),
    index("collection_attempts_retry_due").on(t.orgId, t.nextRetryOn),
  ],
);
