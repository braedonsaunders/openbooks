import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { orgs } from "./core";
import { subscriptions } from "./subscriptions";
import { usageMeters } from "./usage";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * SaaS plan entitlements — the priced capabilities a subscription grants,
 * without a billing-provider dependency. A feature lives in the
 * `saas_features` catalog; each published plan version carries its value,
 * limit and overage policy per feature
 * (`subscription_plan_version_entitlements`); negotiated departures live on
 * the subscription itself (`subscription_entitlement_overrides`) with a
 * recorded reason and an expiry. Resolution is effective-dated throughout:
 * writers close the open row instead of rewriting it, so changing a rule
 * never reinterprets history, and a subscription whose lifecycle pins an
 * older plan version keeps that version's entitlements (grandfathering).
 * `subscription_entitlement_snapshots` caches the current resolution per
 * subscription for low-latency reads.
 */

export const SAAS_FEATURE_TYPES = ["boolean", "quantity", "metered", "custom"] as const;
export const ENTITLEMENT_OVERAGE_POLICIES = ["block", "allow_and_bill", "alert"] as const;

export const saasFeatures = pgTable(
  "saas_features",
  {
    id: id(),
    orgId: orgRef(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    featureType: text("feature_type", { enum: SAAS_FEATURE_TYPES }).notNull(),
    unit: text("unit"),
    meterId: uuid("meter_id"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("saas_features_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("saas_features_org_key_unique").on(t.orgId, t.key),
    index("saas_features_org_active").on(t.orgId, t.isActive),
    check("saas_features_key_nonblank", sql`length(btrim(${t.key})) > 0`),
    check("saas_features_name_nonblank", sql`length(btrim(${t.name})) > 0`),
    check(
      "saas_features_type_valid",
      sql`${t.featureType} in ('boolean', 'quantity', 'metered', 'custom')`,
    ),
    check(
      "saas_features_unit_scope",
      sql`${t.unit} is null or ${t.featureType} in ('quantity', 'metered')`,
    ),
    check(
      "saas_features_meter_scope",
      sql`${t.meterId} is null or ${t.featureType} = 'metered'`,
    ),
    foreignKey({ name: "saas_features_org_fk", columns: [t.orgId], foreignColumns: [orgs.id] }),
    foreignKey({
      name: "saas_features_meter_org_fk",
      columns: [t.orgId, t.meterId],
      foreignColumns: [usageMeters.orgId, usageMeters.id],
    }),
  ],
);

export const subscriptionPlanVersionEntitlements = pgTable(
  "subscription_plan_version_entitlements",
  {
    id: id(),
    orgId: orgRef(),
    planVersionId: uuid("plan_version_id").notNull(),
    featureId: uuid("feature_id").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    limitQty: numeric("limit_qty", { precision: 28, scale: 8 }),
    customValue: text("custom_value"),
    overagePolicy: text("overage_policy", { enum: ENTITLEMENT_OVERAGE_POLICIES })
      .notNull()
      .default("block"),
    meterId: uuid("meter_id"),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("subscription_plan_version_entitlements_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("subscription_plan_version_entitlements_open_unique")
      .on(t.orgId, t.planVersionId, t.featureId)
      .where(sql`${t.effectiveTo} is null`),
    index("subscription_plan_version_entitlements_version_scan").on(
      t.orgId,
      t.planVersionId,
      t.effectiveFrom,
    ),
    check(
      "subscription_plan_version_entitlements_limit_valid",
      sql`${t.limitQty} is null or ${t.limitQty} >= 0`,
    ),
    check(
      "subscription_plan_version_entitlements_overage_valid",
      sql`${t.overagePolicy} in ('block', 'allow_and_bill', 'alert')`,
    ),
    check(
      "subscription_plan_version_entitlements_window_valid",
      sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
    foreignKey({
      name: "subscription_plan_version_entitlements_org_fk",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }),
    foreignKey({
      name: "subscription_plan_version_entitlements_feature_org_fk",
      columns: [t.orgId, t.featureId],
      foreignColumns: [saasFeatures.orgId, saasFeatures.id],
    }),
    foreignKey({
      name: "subscription_plan_version_entitlements_meter_org_fk",
      columns: [t.orgId, t.meterId],
      foreignColumns: [usageMeters.orgId, usageMeters.id],
    }),
  ],
);

export const subscriptionEntitlementOverrides = pgTable(
  "subscription_entitlement_overrides",
  {
    id: id(),
    orgId: orgRef(),
    subscriptionId: uuid("subscription_id").notNull(),
    featureId: uuid("feature_id").notNull(),
    enabled: boolean("enabled"),
    limitQty: numeric("limit_qty", { precision: 28, scale: 8 }),
    customValue: text("custom_value"),
    overagePolicy: text("overage_policy", { enum: ENTITLEMENT_OVERAGE_POLICIES }),
    reason: text("reason").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("subscription_entitlement_overrides_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("subscription_entitlement_overrides_open_unique")
      .on(t.orgId, t.subscriptionId, t.featureId)
      .where(sql`${t.effectiveTo} is null`),
    index("subscription_entitlement_overrides_subscription_scan").on(
      t.orgId,
      t.subscriptionId,
      t.effectiveFrom,
    ),
    check(
      "subscription_entitlement_overrides_limit_valid",
      sql`${t.limitQty} is null or ${t.limitQty} >= 0`,
    ),
    check(
      "subscription_entitlement_overrides_delta_present",
      sql`${t.enabled} is not null or ${t.limitQty} is not null or ${t.customValue} is not null or ${t.overagePolicy} is not null`,
    ),
    check(
      "subscription_entitlement_overrides_overage_valid",
      sql`${t.overagePolicy} is null or ${t.overagePolicy} in ('block', 'allow_and_bill', 'alert')`,
    ),
    check(
      "subscription_entitlement_overrides_reason_nonblank",
      sql`length(btrim(${t.reason})) > 0`,
    ),
    check(
      "subscription_entitlement_overrides_window_valid",
      sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
    foreignKey({
      name: "subscription_entitlement_overrides_org_fk",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }),
    foreignKey({
      name: "subscription_entitlement_overrides_subscription_org_fk",
      columns: [t.orgId, t.subscriptionId],
      foreignColumns: [subscriptions.orgId, subscriptions.id],
    }),
    foreignKey({
      name: "subscription_entitlement_overrides_feature_org_fk",
      columns: [t.orgId, t.featureId],
      foreignColumns: [saasFeatures.orgId, saasFeatures.id],
    }),
  ],
);

export const subscriptionEntitlementSnapshots = pgTable(
  "subscription_entitlement_snapshots",
  {
    id: id(),
    orgId: orgRef(),
    subscriptionId: uuid("subscription_id").notNull(),
    snapshot: jsonb("snapshot").notNull().default([]),
    sourceHash: text("source_hash").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("subscription_entitlement_snapshots_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("subscription_entitlement_snapshots_subscription_unique").on(
      t.orgId,
      t.subscriptionId,
    ),
    check(
      "subscription_entitlement_snapshots_hash_nonblank",
      sql`length(btrim(${t.sourceHash})) > 0`,
    ),
    foreignKey({
      name: "subscription_entitlement_snapshots_org_fk",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }),
    foreignKey({
      name: "subscription_entitlement_snapshots_subscription_org_fk",
      columns: [t.orgId, t.subscriptionId],
      foreignColumns: [subscriptions.orgId, subscriptions.id],
    }),
  ],
);
