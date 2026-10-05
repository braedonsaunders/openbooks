import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, currencyCode, id, money, orgRef } from "./helpers";
import { documentLines, documents } from "./documents";

/**
 * Subscription billing — SaaS/retainer style recurring revenue on top of the
 * document kernel. A plan is a priced, repeating offering; a subscription binds
 * a customer to a plan at a quantity, and the engine generates a customer
 * invoice each period and advances the next bill date. Gated by the
 * `subscriptionBilling` feature. Unlike raw recurring_schedules (which clone a
 * template document), subscriptions carry plan/price/quantity semantics, so MRR
 * and proration are computable.
 */
export const subscriptionPlans = pgTable(
  "subscription_plans",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    description: text("description"),
    amount: money("amount").notNull().default("0"),
    currency: currencyCode(),
    interval: text("interval", { enum: ["weekly", "monthly", "quarterly", "annually"] })
      .notNull()
      .default("monthly"),
    /** e.g. interval=monthly, count=3 → every 3 months. */
    intervalCount: integer("interval_count").notNull().default(1),
    incomeAccountId: uuid("income_account_id"),
    itemId: uuid("item_id"),
    taxCodeId: uuid("tax_code_id"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    index("subscription_plans_org").on(t.orgId, t.isActive),
    check("subscription_plans_amount_nonnegative", sql`${t.amount} >= 0`),
    check(
      "subscription_plans_cadence_valid",
      sql`${t.interval} in ('weekly', 'monthly', 'quarterly', 'annually') and ${t.intervalCount} > 0`,
    ),
  ],
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: id(),
    orgId: orgRef(),
    customerId: uuid("customer_id").notNull(),
    planId: uuid("plan_id").notNull(),
    quantity: money("quantity").notNull().default("1"),
    /** Overrides the plan amount when set (negotiated price). */
    priceOverride: money("price_override"),
    // Suspended is collections-driven (failed autopay after the final retry):
    // billing stops like paused, but the contract stays for reactivation on
    // the next successful payment. Paused remains the operator control.
    status: text("status", { enum: ["active", "paused", "suspended", "canceled"] })
      .notNull()
      .default("active"),
    startOn: date("start_on").notNull(),
    nextBillOn: date("next_bill_on").notNull(),
    /** Start of the period next_bill_on closes — for mid-period proration. */
    currentPeriodStart: date("current_period_start"),
    canceledOn: date("canceled_on"),
    /** Auto-post the generated invoice vs leave it as a draft. */
    autoPost: boolean("auto_post").notNull().default(false),
    /**
     * Per-subscription bill-to/payer overrides. Null means the payer
     * hierarchy relationship (or self-billing) applies on the billing date.
     */
    billToPartyId: uuid("bill_to_party_id"),
    payerPartyId: uuid("payer_party_id"),
    lastInvoiceId: uuid("last_invoice_id"),
    lastBilledAt: timestamp("last_billed_at", { withTimezone: true }),
    runCount: integer("run_count").notNull().default(0),
    lastError: text("last_error"),
    memo: text("memo"),
    /** Quote activated into this subscription: part of the exactly-once
     * authority for quote activation (0506_quote_to_cash). */
    sourceQuoteId: uuid("source_quote_id"),
    /** Quote term activated into this subscription (one per quote line term). */
    sourceTermId: uuid("source_term_id"),
    ...auditColumns,
  },
  (t) => [
    index("subscriptions_org_status").on(t.orgId, t.status),
    index("subscriptions_due").on(t.status, t.nextBillOn),
    uniqueIndex("subscriptions_source_term_unique")
      .on(t.orgId, t.sourceQuoteId, t.sourceTermId)
      .where(sql`${t.sourceQuoteId} IS NOT NULL`),
    foreignKey({
      columns: [t.orgId, t.sourceQuoteId],
      foreignColumns: [documents.orgId, documents.id],
      name: "subscriptions_source_quote_fk",
    }),
    check(
      "subscriptions_pricing_valid",
      sql`${t.quantity} > 0 and (${t.priceOverride} is null or ${t.priceOverride} >= 0)`,
    ),
    check(
      "subscriptions_period_valid",
      sql`${t.startOn} <= ${t.nextBillOn}
          and (${t.currentPeriodStart} is null
            or (${t.currentPeriodStart} >= ${t.startOn} and ${t.currentPeriodStart} <= ${t.nextBillOn}))`,
    ),
  ],
);

/**
 * Quote-to-cash (0506_quote_to_cash): policy per organization, edited in
 * Setup. Absent rows read as the working defaults in the engine, so the
 * surface needs zero setup. At most one row per org.
 */
export const quoteToCashSettings = pgTable(
  "quote_to_cash_settings",
  {
    id: id(),
    orgId: orgRef(),
    maxDiscountPercent: numeric("max_discount_percent", { precision: 9, scale: 4 })
      .notNull()
      .default("10"),
    autoActivateOnSign: boolean("auto_activate_on_sign").notNull().default(false),
    defaultBillingTiming: text("default_billing_timing", { enum: ["advance", "arrears"] })
      .notNull()
      .default("advance"),
    defaultStartRule: text("default_start_rule", {
      enum: ["quote_date", "first_of_next_month", "custom"],
    })
      .notNull()
      .default("quote_date"),
    signatureExpiryDays: integer("signature_expiry_days").notNull().default(14),
    /** PDF template rendering the signing presentation; null keeps the quote default. */
    orderFormTemplateId: uuid("order_form_template_id"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("quote_to_cash_settings_org_unique").on(t.orgId),
    check(
      "quote_to_cash_settings_discount_valid",
      sql`${t.maxDiscountPercent} >= 0 AND ${t.maxDiscountPercent} <= 100`,
    ),
    check(
      "quote_to_cash_settings_expiry_valid",
      sql`${t.signatureExpiryDays} >= 1 AND ${t.signatureExpiryDays} <= 90`,
    ),
  ],
);

/**
 * Quote-to-cash (0506_quote_to_cash): subscription terms priced on a quote
 * line. The plan prices the term; the plan version, when set, carries the
 * contract-grade lifecycle the activation adopts. A co-term line rides the
 * named subscription instead of opening its own term.
 */
export const quoteSubscriptionTerms = pgTable(
  "quote_subscription_terms",
  {
    id: id(),
    orgId: orgRef(),
    quoteId: uuid("quote_id").notNull(),
    quoteLineId: uuid("quote_line_id").notNull(),
    planId: uuid("plan_id").notNull(),
    /** No drizzle table object exists for plan versions (SQL-only); the
     * database foreign key is the authority. */
    planVersionId: uuid("plan_version_id"),
    termMonths: integer("term_months").notNull(),
    startRule: text("start_rule", {
      enum: ["quote_date", "first_of_next_month", "custom"],
    })
      .notNull()
      .default("quote_date"),
    billingTiming: text("billing_timing", { enum: ["advance", "arrears"] })
      .notNull()
      .default("advance"),
    cotermSubscriptionId: uuid("coterm_subscription_id"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("quote_subscription_terms_line_unique").on(t.orgId, t.quoteId, t.quoteLineId),
    foreignKey({
      columns: [t.orgId, t.quoteId],
      foreignColumns: [documents.orgId, documents.id],
      name: "quote_subscription_terms_quote_fk",
    }),
    foreignKey({
      columns: [t.orgId, t.quoteLineId],
      foreignColumns: [documentLines.orgId, documentLines.id],
      name: "quote_subscription_terms_line_fk",
    }),
    foreignKey({
      columns: [t.orgId, t.planId],
      foreignColumns: [subscriptionPlans.orgId, subscriptionPlans.id],
      name: "quote_subscription_terms_plan_fk",
    }),
    foreignKey({
      columns: [t.orgId, t.cotermSubscriptionId],
      foreignColumns: [subscriptions.orgId, subscriptions.id],
      name: "quote_subscription_terms_coterm_fk",
    }),
    check(
      "quote_subscription_terms_months_valid",
      sql`${t.termMonths} >= 1 AND ${t.termMonths} <= 120`,
    ),
  ],
);

/**
 * Quote-to-cash (0506_quote_to_cash): priced periods of a term's ramp. The
 * unit price and quantity apply from starts_after_months into the term; the
 * escalator prices the next period from this one. Period 0 starts the term.
 */
export const quoteRampSteps = pgTable(
  "quote_ramp_steps",
  {
    id: id(),
    orgId: orgRef(),
    termId: uuid("term_id").notNull(),
    periodIndex: integer("period_index").notNull(),
    startsAfterMonths: integer("starts_after_months").notNull(),
    unitPrice: money("unit_price").notNull(),
    quantity: money("quantity").notNull(),
    escalatorPercent: numeric("escalator_percent", { precision: 9, scale: 4 }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("quote_ramp_steps_period_unique").on(t.orgId, t.termId, t.periodIndex),
    foreignKey({
      columns: [t.orgId, t.termId],
      foreignColumns: [quoteSubscriptionTerms.orgId, quoteSubscriptionTerms.id],
      name: "quote_ramp_steps_term_fk",
    }),
    check(
      "quote_ramp_steps_period_valid",
      sql`${t.periodIndex} >= 0 AND ${t.startsAfterMonths} >= 0`,
    ),
    check(
      "quote_ramp_steps_price_valid",
      sql`${t.unitPrice} >= 0 AND ${t.quantity} > 0`,
    ),
    check(
      "quote_ramp_steps_escalator_valid",
      sql`${t.escalatorPercent} IS NULL OR (${t.escalatorPercent} >= -100 AND ${t.escalatorPercent} <= 100)`,
    ),
  ],
);
