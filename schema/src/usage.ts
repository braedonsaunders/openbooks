import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  integer,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { orgs } from "./core";
import { documentLines, documents, items } from "./documents";
import { parties } from "./parties";
import { subscriptions } from "./subscriptions";
import { currencyCode, id, money, orgRef } from "./helpers";

export const USAGE_AGGREGATIONS = ["sum", "count", "max", "last", "unique_count"] as const;
export const USAGE_RECORD_SOURCES = ["api", "import", "connector_stripe", "manual"] as const;
export const USAGE_BAND_KINDS = [
  "graduated",
  "volume",
  "package",
  "overage",
  "commit_shortfall",
  "prepaid_drawdown",
] as const;
export const USAGE_PACKAGE_ROUNDINGS = ["up", "down"] as const;
export const USAGE_COMMIT_PERIODS = ["monthly", "annual"] as const;

export const usageMeters = pgTable(
  "usage_meters",
  {
    id: id(),
    orgId: orgRef(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    unit: text("unit").notNull(),
    aggregation: text("aggregation", { enum: USAGE_AGGREGATIONS }).notNull(),
    itemId: uuid("item_id"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by"),
  },
  (t) => [
    uniqueIndex("usage_meters_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("usage_meters_org_key_unique").on(t.orgId, t.key),
    index("usage_meters_org_active").on(t.orgId, t.isActive),
    check("usage_meters_key_nonblank", sql`length(btrim(${t.key})) > 0`),
    check("usage_meters_name_nonblank", sql`length(btrim(${t.name})) > 0`),
    check("usage_meters_unit_nonblank", sql`length(btrim(${t.unit})) > 0`),
    check(
      "usage_meters_aggregation_valid",
      sql`${t.aggregation} in ('sum', 'count', 'max', 'last', 'unique_count')`,
    ),
    foreignKey({ name: "usage_meters_org_fk", columns: [t.orgId], foreignColumns: [orgs.id] }),
    foreignKey({
      name: "usage_meters_item_org_fk",
      columns: [t.orgId, t.itemId],
      foreignColumns: [items.orgId, items.id],
    }),
  ],
);

export const usageRecords = pgTable(
  "usage_records",
  {
    id: id(),
    orgId: orgRef(),
    meterId: uuid("meter_id").notNull(),
    customerId: uuid("customer_id").notNull(),
    subscriptionId: uuid("subscription_id"),
    occurredOn: date("occurred_on").notNull(),
    quantity: numeric("quantity", { precision: 28, scale: 8 }).notNull(),
    distinctKey: text("distinct_key"),
    source: text("source", { enum: USAGE_RECORD_SOURCES }).notNull(),
    sourceRef: text("source_ref"),
    idempotencyKey: text("idempotency_key").notNull(),
    reversesId: uuid("reverses_id"),
    reversalReason: text("reversal_reason"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("usage_records_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("usage_records_org_meter_idempotency_unique").on(t.orgId, t.meterId, t.idempotencyKey),
    uniqueIndex("usage_records_one_reversal").on(t.orgId, t.reversesId).where(sql`${t.reversesId} is not null`),
    index("usage_records_window").on(t.orgId, t.meterId, t.customerId, t.occurredOn, t.id),
    check(
      "usage_records_source_valid",
      sql`${t.source} in ('api', 'import', 'connector_stripe', 'manual')`,
    ),
    check(
      "usage_records_quantity_valid",
      sql`(${t.reversesId} is null and ${t.quantity} > 0) or (${t.reversesId} is not null and ${t.quantity} < 0)`,
    ),
    check(
      "usage_records_reversal_reason",
      sql`(${t.reversesId} is null and ${t.reversalReason} is null) or (${t.reversesId} is not null and ${t.reversalReason} is not null and length(btrim(${t.reversalReason})) > 0)`,
    ),
    foreignKey({ name: "usage_records_org_fk", columns: [t.orgId], foreignColumns: [orgs.id] }),
    foreignKey({
      name: "usage_records_meter_org_fk",
      columns: [t.orgId, t.meterId],
      foreignColumns: [usageMeters.orgId, usageMeters.id],
    }),
    foreignKey({
      name: "usage_records_customer_org_fk",
      columns: [t.orgId, t.customerId],
      foreignColumns: [parties.orgId, parties.id],
    }),
    foreignKey({
      name: "usage_records_subscription_org_fk",
      columns: [t.orgId, t.subscriptionId],
      foreignColumns: [subscriptions.orgId, subscriptions.id],
    }),
    foreignKey({
      name: "usage_records_reverses_org_fk",
      columns: [t.orgId, t.reversesId],
      foreignColumns: [t.orgId, t.id],
    }),
  ],
);

export const usageRatingPlans = pgTable(
  "usage_rating_plans",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    currency: currencyCode(),
    status: text("status", { enum: ["active", "retired"] }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by"),
  },
  (t) => [
    uniqueIndex("usage_rating_plans_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("usage_rating_plans_org_name_unique").on(t.orgId, t.name),
    index("usage_rating_plans_org_status").on(t.orgId, t.status),
    check("usage_rating_plans_name_nonblank", sql`length(btrim(${t.name})) > 0`),
    check("usage_rating_plans_currency_valid", sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check("usage_rating_plans_status_valid", sql`${t.status} in ('active', 'retired')`),
    foreignKey({ name: "usage_rating_plans_org_fk", columns: [t.orgId], foreignColumns: [orgs.id] }),
  ],
);

export const usageRatingPlanVersions = pgTable(
  "usage_rating_plan_versions",
  {
    id: id(),
    orgId: orgRef(),
    planId: uuid("plan_id").notNull(),
    versionNo: integer("version_no").notNull(),
    status: text("status", { enum: ["draft", "published"] }).notNull().default("draft"),
    effectiveFrom: date("effective_from").notNull(),
    specHash: text("spec_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by"),
  },
  (t) => [
    uniqueIndex("usage_rating_plan_versions_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("usage_rating_plan_versions_plan_version_unique").on(t.orgId, t.planId, t.versionNo),
    index("usage_rating_plan_versions_org_plan_status").on(t.orgId, t.planId, t.status),
    check("usage_rating_plan_versions_number_positive", sql`${t.versionNo} > 0`),
    check("usage_rating_plan_versions_status_valid", sql`${t.status} in ('draft', 'published')`),
    check(
      "usage_rating_plan_versions_publication_shape",
      sql`(${t.status} = 'draft' and ${t.specHash} is null) or (${t.status} = 'published' and ${t.specHash} is not null and ${t.specHash} ~ '^[0-9a-f]{64}$')`,
    ),
    foreignKey({ name: "usage_rating_plan_versions_org_fk", columns: [t.orgId], foreignColumns: [orgs.id] }),
    foreignKey({
      name: "usage_rating_plan_versions_plan_org_fk",
      columns: [t.orgId, t.planId],
      foreignColumns: [usageRatingPlans.orgId, usageRatingPlans.id],
    }),
  ],
);

export const usageRatingBands = pgTable(
  "usage_rating_bands",
  {
    id: id(),
    orgId: orgRef(),
    planVersionId: uuid("plan_version_id").notNull(),
    meterId: uuid("meter_id").notNull(),
    kind: text("kind", { enum: USAGE_BAND_KINDS }).notNull(),
    seq: integer("seq").notNull(),
    upToQty: numeric("up_to_qty", { precision: 28, scale: 8 }),
    unitPrice: numeric("unit_price", { precision: 28, scale: 8 }).notNull(),
    flatAmount: money("flat_amount").notNull().default("0"),
    includedQty: numeric("included_qty", { precision: 28, scale: 8 }).notNull().default("0"),
    packageSize: numeric("package_size", { precision: 28, scale: 8 }),
    packageRounding: text("package_rounding", { enum: USAGE_PACKAGE_ROUNDINGS }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by"),
  },
  (t) => [
    uniqueIndex("usage_rating_bands_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("usage_rating_bands_version_meter_seq_unique").on(t.orgId, t.planVersionId, t.meterId, t.seq),
    index("usage_rating_bands_meter").on(t.orgId, t.meterId, t.planVersionId),
    check("usage_rating_bands_seq_positive", sql`${t.seq} > 0`),
    check(
      "usage_rating_bands_kind_valid",
      sql`${t.kind} in ('graduated', 'volume', 'package', 'overage', 'commit_shortfall', 'prepaid_drawdown')`,
    ),
    check(
      "usage_rating_bands_package_rounding_valid",
      sql`${t.packageRounding} is null or ${t.packageRounding} in ('up', 'down')`,
    ),
    check("usage_rating_bands_upper_bound_nonnegative", sql`${t.upToQty} is null or ${t.upToQty} >= 0`),
    check("usage_rating_bands_unit_price_nonnegative", sql`${t.unitPrice} >= 0`),
    check("usage_rating_bands_flat_amount_nonnegative", sql`${t.flatAmount} >= 0`),
    check("usage_rating_bands_included_qty_nonnegative", sql`${t.includedQty} >= 0`),
    check(
      "usage_rating_bands_package_shape",
      sql`(${t.kind} = 'package' and ${t.packageSize} is not null and ${t.packageSize} > 0 and ${t.packageRounding} is not null and ${t.packageRounding} in ('up', 'down')) or (${t.kind} <> 'package' and ${t.packageSize} is null and ${t.packageRounding} is null)`,
    ),
    foreignKey({ name: "usage_rating_bands_org_fk", columns: [t.orgId], foreignColumns: [orgs.id] }),
    foreignKey({
      name: "usage_rating_bands_version_org_fk",
      columns: [t.orgId, t.planVersionId],
      foreignColumns: [usageRatingPlanVersions.orgId, usageRatingPlanVersions.id],
    }),
    foreignKey({
      name: "usage_rating_bands_meter_org_fk",
      columns: [t.orgId, t.meterId],
      foreignColumns: [usageMeters.orgId, usageMeters.id],
    }),
  ],
);

export const subscriptionUsageLinks = pgTable(
  "subscription_usage_links",
  {
    id: id(),
    orgId: orgRef(),
    subscriptionId: uuid("subscription_id").notNull(),
    customerId: uuid("customer_id").notNull(),
    planVersionId: uuid("plan_version_id").notNull(),
    meterIds: uuid("meter_ids").array().notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    commitAmount: money("commit_amount"),
    commitPeriod: text("commit_period", { enum: USAGE_COMMIT_PERIODS }),
    allowOverage: boolean("allow_overage").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by"),
  },
  (t) => [
    uniqueIndex("subscription_usage_links_org_id_id_unique").on(t.orgId, t.id),
    index("subscription_usage_links_subscription_window").on(t.orgId, t.subscriptionId, t.effectiveFrom, t.effectiveTo),
    check("subscription_usage_links_meter_set_nonempty", sql`cardinality(${t.meterIds}) > 0`),
    check("subscription_usage_links_window_valid", sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`),
    check(
      "subscription_usage_links_commit_pair",
      sql`(${t.commitAmount} is null and ${t.commitPeriod} is null) or (${t.commitAmount} is not null and ${t.commitAmount} > 0 and ${t.commitPeriod} is not null and ${t.commitPeriod} in ('monthly', 'annual'))`,
    ),
    check(
      "subscription_usage_links_commit_period_valid",
      sql`${t.commitPeriod} is null or ${t.commitPeriod} in ('monthly', 'annual')`,
    ),
    foreignKey({ name: "subscription_usage_links_org_fk", columns: [t.orgId], foreignColumns: [orgs.id] }),
    foreignKey({
      name: "subscription_usage_links_subscription_org_fk",
      columns: [t.orgId, t.subscriptionId],
      foreignColumns: [subscriptions.orgId, subscriptions.id],
    }),
    foreignKey({
      name: "subscription_usage_links_customer_org_fk",
      columns: [t.orgId, t.customerId],
      foreignColumns: [parties.orgId, parties.id],
    }),
    foreignKey({
      name: "subscription_usage_links_version_org_fk",
      columns: [t.orgId, t.planVersionId],
      foreignColumns: [usageRatingPlanVersions.orgId, usageRatingPlanVersions.id],
    }),
  ],
);

export const usageRatingRuns = pgTable(
  "usage_rating_runs",
  {
    id: id(),
    orgId: orgRef(),
    linkId: uuid("link_id").notNull(),
    planVersionId: uuid("plan_version_id").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    inputHash: text("input_hash").notNull(),
    outputHash: text("output_hash").notNull(),
    status: text("status", { enum: ["active", "superseded"] }).notNull().default("active"),
    supersedesRunId: uuid("supersedes_run_id"),
    invoiceId: uuid("invoice_id"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("usage_rating_runs_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("usage_rating_runs_active_window_unique")
      .on(t.orgId, t.linkId, t.periodStart, t.periodEnd)
      .where(sql`${t.status} = 'active'`),
    index("usage_rating_runs_invoice").on(t.orgId, t.invoiceId),
    check("usage_rating_runs_period_valid", sql`${t.periodStart} <= ${t.periodEnd}`),
    check("usage_rating_runs_hashes_valid", sql`${t.inputHash} ~ '^[0-9a-f]{64}$' and ${t.outputHash} ~ '^[0-9a-f]{64}$'`),
    check("usage_rating_runs_status_valid", sql`${t.status} in ('active', 'superseded')`),
    check("usage_rating_runs_not_self_superseding", sql`${t.supersedesRunId} is null or ${t.supersedesRunId} <> ${t.id}`),
    foreignKey({ name: "usage_rating_runs_org_fk", columns: [t.orgId], foreignColumns: [orgs.id] }),
    foreignKey({
      name: "usage_rating_runs_link_org_fk",
      columns: [t.orgId, t.linkId],
      foreignColumns: [subscriptionUsageLinks.orgId, subscriptionUsageLinks.id],
    }),
    foreignKey({
      name: "usage_rating_runs_version_org_fk",
      columns: [t.orgId, t.planVersionId],
      foreignColumns: [usageRatingPlanVersions.orgId, usageRatingPlanVersions.id],
    }),
    foreignKey({
      name: "usage_rating_runs_supersedes_org_fk",
      columns: [t.orgId, t.supersedesRunId],
      foreignColumns: [t.orgId, t.id],
    }),
    foreignKey({
      name: "usage_rating_runs_invoice_org_fk",
      columns: [t.orgId, t.invoiceId],
      foreignColumns: [documents.orgId, documents.id],
    }),
  ],
);

export const usagePrepaidGrants = pgTable(
  "usage_prepaid_grants",
  {
    id: id(),
    orgId: orgRef(),
    customerId: uuid("customer_id").notNull(),
    sourceDocumentLineId: uuid("source_document_line_id").notNull(),
    amount: money("amount").notNull(),
    currency: currencyCode(),
    expiresOn: date("expires_on"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
  },
  (t) => [
    uniqueIndex("usage_prepaid_grants_org_id_id_unique").on(t.orgId, t.id),
    index("usage_prepaid_grants_customer_expiry").on(t.orgId, t.customerId, t.expiresOn),
    index("usage_prepaid_grants_source_line").on(t.orgId, t.sourceDocumentLineId),
    check("usage_prepaid_grants_amount_positive", sql`${t.amount} > 0`),
    check("usage_prepaid_grants_currency_valid", sql`${t.currency} ~ '^[A-Z]{3}$'`),
    foreignKey({ name: "usage_prepaid_grants_org_fk", columns: [t.orgId], foreignColumns: [orgs.id] }),
    foreignKey({
      name: "usage_prepaid_grants_customer_org_fk",
      columns: [t.orgId, t.customerId],
      foreignColumns: [parties.orgId, parties.id],
    }),
    foreignKey({
      name: "usage_prepaid_grants_source_line_org_fk",
      columns: [t.orgId, t.sourceDocumentLineId],
      foreignColumns: [documentLines.orgId, documentLines.id],
    }),
  ],
);

export const usagePrepaidDraws = pgTable(
  "usage_prepaid_draws",
  {
    id: id(),
    orgId: orgRef(),
    grantId: uuid("grant_id").notNull(),
    runId: uuid("run_id"),
    periodMonth: date("period_month").notNull(),
    amount: money("amount").notNull(),
    reversesDrawId: uuid("reverses_draw_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("usage_prepaid_draws_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("usage_prepaid_draws_run_grant_period_unique")
      .on(t.orgId, t.runId, t.grantId, t.periodMonth)
      .where(sql`${t.reversesDrawId} is null`),
    uniqueIndex("usage_prepaid_draws_reverses_draw_unique")
      .on(t.orgId, t.reversesDrawId)
      .where(sql`${t.reversesDrawId} is not null`),
    index("usage_prepaid_draws_grant_period").on(t.orgId, t.grantId, t.periodMonth),
    check(
      "usage_prepaid_draws_amount_positive",
      sql`(${t.reversesDrawId} is null and ${t.amount} > 0) or (${t.reversesDrawId} is not null and ${t.amount} < 0)`,
    ),
    check("usage_prepaid_draws_period_month_first", sql`extract(day from ${t.periodMonth}) = 1`),
    foreignKey({ name: "usage_prepaid_draws_org_fk", columns: [t.orgId], foreignColumns: [orgs.id] }),
    foreignKey({
      name: "usage_prepaid_draws_reverses_org_fk",
      columns: [t.orgId, t.reversesDrawId],
      foreignColumns: [t.orgId, t.id],
    }),
    foreignKey({
      name: "usage_prepaid_draws_grant_org_fk",
      columns: [t.orgId, t.grantId],
      foreignColumns: [usagePrepaidGrants.orgId, usagePrepaidGrants.id],
    }),
    foreignKey({
      name: "usage_prepaid_draws_run_org_fk",
      columns: [t.orgId, t.runId],
      foreignColumns: [usageRatingRuns.orgId, usageRatingRuns.id],
    }),
  ],
);
