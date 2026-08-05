import {
  boolean,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, currencyCode, id, money, orgRef } from "./helpers";

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
  (t) => [index("subscription_plans_org").on(t.orgId, t.isActive)],
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
    status: text("status", { enum: ["active", "paused", "canceled"] })
      .notNull()
      .default("active"),
    startOn: date("start_on").notNull(),
    nextBillOn: date("next_bill_on").notNull(),
    /** Start of the period next_bill_on closes — for mid-period proration. */
    currentPeriodStart: date("current_period_start"),
    canceledOn: date("canceled_on"),
    /** Auto-post the generated invoice vs leave it as a draft. */
    autoPost: boolean("auto_post").notNull().default(false),
    lastInvoiceId: uuid("last_invoice_id"),
    lastBilledAt: timestamp("last_billed_at", { withTimezone: true }),
    runCount: integer("run_count").notNull().default(0),
    lastError: text("last_error"),
    memo: text("memo"),
    ...auditColumns,
  },
  (t) => [
    index("subscriptions_org_status").on(t.orgId, t.status),
    index("subscriptions_due").on(t.status, t.nextBillOn),
  ],
);
