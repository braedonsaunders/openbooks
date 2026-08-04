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
import { auditColumns, currencyCode, id, money, orgRef } from "./helpers";

export const SUBSCRIPTION_BILLING_TIMINGS = ["advance", "arrears"] as const;
export const SUBSCRIPTION_RENEWAL_POLICIES = ["auto", "manual", "none"] as const;
export const SUBSCRIPTION_AMENDMENT_TYPES = [
  "add_component",
  "remove_component",
  "change_component",
  "change_term",
  "change_timing",
  "renew",
  "coterm",
] as const;

/**
 * Effective-dated, publish-once commercial catalog. The base plan remains the
 * stable product identity; versions freeze the
 * commercial terms that were actually offered and accepted.
 */
export const subscriptionPlanVersions = pgTable(
  "subscription_plan_versions",
  {
    id: id(),
    orgId: orgRef(),
    planId: uuid("plan_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    status: text("status", { enum: ["draft", "published", "superseded"] }).notNull().default("draft"),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    name: text("name").notNull(),
    description: text("description"),
    currency: currencyCode(),
    interval: text("interval", { enum: ["weekly", "monthly", "quarterly", "annually"] }).notNull(),
    intervalCount: integer("interval_count").notNull().default(1),
    billingTiming: text("billing_timing", { enum: SUBSCRIPTION_BILLING_TIMINGS }).notNull().default("advance"),
    changeSummary: text("change_summary"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: uuid("published_by"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("subscription_plan_versions_number").on(t.orgId, t.planId, t.versionNumber),
    index("subscription_plan_versions_effective").on(t.orgId, t.planId, t.effectiveFrom, t.effectiveTo),
  ],
);

export const subscriptionPlanVersionComponents = pgTable(
  "subscription_plan_version_components",
  {
    id: id(),
    orgId: orgRef(),
    versionId: uuid("version_id").notNull(),
    componentKey: text("component_key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    quantity: money("quantity").notNull().default("1"),
    unitPrice: money("unit_price").notNull().default("0"),
    incomeAccountId: uuid("income_account_id"),
    itemId: uuid("item_id"),
    taxCodeId: uuid("tax_code_id"),
    isOptional: boolean("is_optional").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("subscription_plan_version_component_key").on(t.versionId, t.componentKey),
    index("subscription_plan_version_components_org").on(t.orgId, t.versionId),
  ],
);

/** One-to-one commercial lifecycle extension for a subscription. */
export const subscriptionLifecycles = pgTable(
  "subscription_lifecycles",
  {
    id: id(),
    orgId: orgRef(),
    subscriptionId: uuid("subscription_id").notNull(),
    planVersionId: uuid("plan_version_id").notNull(),
    contractRevision: integer("contract_revision").notNull().default(1),
    termStartsOn: date("term_starts_on").notNull(),
    termEndsOn: date("term_ends_on"),
    trialEndsOn: date("trial_ends_on"),
    billingTiming: text("billing_timing", { enum: SUBSCRIPTION_BILLING_TIMINGS }).notNull().default("advance"),
    renewalPolicy: text("renewal_policy", { enum: SUBSCRIPTION_RENEWAL_POLICIES }).notNull().default("auto"),
    renewalTermMonths: integer("renewal_term_months"),
    renewalOn: date("renewal_on"),
    cotermAnchorSubscriptionId: uuid("coterm_anchor_subscription_id"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("subscription_lifecycle_subscription").on(t.subscriptionId),
    index("subscription_lifecycles_renewal").on(t.orgId, t.renewalOn, t.renewalPolicy),
  ],
);

/** Frozen billable component snapshot. Amendments date out rows and append replacements. */
export const subscriptionComponents = pgTable(
  "subscription_components",
  {
    id: id(),
    orgId: orgRef(),
    subscriptionId: uuid("subscription_id").notNull(),
    sourceVersionComponentId: uuid("source_version_component_id"),
    componentKey: text("component_key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    quantity: money("quantity").notNull().default("1"),
    unitPrice: money("unit_price").notNull().default("0"),
    incomeAccountId: uuid("income_account_id"),
    itemId: uuid("item_id"),
    taxCodeId: uuid("tax_code_id"),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    sortOrder: integer("sort_order").notNull().default(0),
    ...auditColumns,
  },
  (t) => [
    index("subscription_components_effective").on(t.orgId, t.subscriptionId, t.effectiveFrom, t.effectiveTo),
  ],
);

/** Append-only contract history with an idempotency key for safe retries. */
export const subscriptionAmendments = pgTable(
  "subscription_amendments",
  {
    id: id(),
    orgId: orgRef(),
    subscriptionId: uuid("subscription_id").notNull(),
    amendmentNumber: integer("amendment_number").notNull(),
    amendmentType: text("amendment_type", { enum: SUBSCRIPTION_AMENDMENT_TYPES }).notNull(),
    effectiveOn: date("effective_on").notNull(),
    status: text("status", { enum: ["pending", "applied", "voided"] }).notNull().default("pending"),
    idempotencyKey: text("idempotency_key").notNull(),
    reason: text("reason"),
    request: jsonb("request").$type<Record<string, unknown>>().notNull().default({}),
    beforeSnapshot: jsonb("before_snapshot").$type<Record<string, unknown>>().notNull().default({}),
    afterSnapshot: jsonb("after_snapshot").$type<Record<string, unknown>>().notNull().default({}),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    appliedBy: uuid("applied_by"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("subscription_amendment_idempotency").on(t.orgId, t.idempotencyKey),
    uniqueIndex("subscription_amendment_number").on(t.subscriptionId, t.amendmentNumber),
    index("subscription_amendments_history").on(t.orgId, t.subscriptionId, t.effectiveOn),
  ],
);

/** Idempotency guard for one subscription period/revision invoice. */
export const subscriptionPeriodInvoices = pgTable(
  "subscription_period_invoices",
  {
    id: id(),
    orgId: orgRef(),
    subscriptionId: uuid("subscription_id").notNull(),
    periodStartsOn: date("period_starts_on").notNull(),
    periodEndsOn: date("period_ends_on").notNull(),
    contractRevision: integer("contract_revision").notNull(),
    invoiceId: uuid("invoice_id").notNull(),
    billedAt: timestamp("billed_at", { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("subscription_period_invoice_once").on(t.subscriptionId, t.periodStartsOn, t.periodEndsOn, t.contractRevision),
    uniqueIndex("subscription_period_invoice_document").on(t.invoiceId),
  ],
);
