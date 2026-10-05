import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accounts } from "./coa";
import { orgs } from "./core";
import { stockLocations } from "./inventory";
import { subsidiaries } from "./subsidiaries";
import { auditColumns, currencyCode, id, orgRef } from "./helpers";

export const SALES_CHANNEL_KINDS = ["shopify"] as const;
export const SALES_CHANNEL_STATUSES = [
  "draft",
  "connecting",
  "active",
  "paused",
  "disconnected",
  "error",
] as const;

export const SALES_CHANNEL_ACCOUNT_ROLES = [
  "gateway_clearing",
  "revenue",
  "discount",
  "shipping_income",
  "gift_card_liability",
  "sales_tax_liability",
  "rounding",
  "refund_clearing",
] as const;

export const EXTERNAL_LINK_PROVIDERS = [
  "shopify",
  "stripe",
  "chargebee",
  "recurly",
  "maxio",
  "zuora",
] as const;
export const EXTERNAL_LINK_OBJECT_TYPES = [
  "product",
  "variant",
  "customer",
  "order",
  "refund",
  "fulfillment",
  "payout",
  "location",
  "gift_card",
  "subscription",
  "price",
  "meter",
  "subscription_item",
  "invoice",
  "credit_note",
  "payment",
  "coupon",
] as const;
export const EXTERNAL_LINK_NATIVE_TABLES = [
  "items",
  "item_families",
  "parties",
  "documents",
  "stock_locations",
  "stored_value_accounts",
  "subscriptions",
  "subscription_items",
  "subscription_usage_links",
  "usage_meters",
  "usage_rating_plan_versions",
  "promotions",
] as const;

export const INBOUND_EVENT_STATUSES = [
  "pending",
  "processing",
  "processed",
  "ignored",
  "failed",
  "dead",
] as const;

/** Postgres `bytea` mapped to raw bytes (node-postgres returns a Buffer). */
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return "bytea";
  },
});

/** One connected storefront. Secrets stay sealed tenant-bound ciphertext. */
export const salesChannels = pgTable(
  "sales_channels",
  {
    id: id(),
    orgId: orgRef(),
    kind: text("kind", { enum: SALES_CHANNEL_KINDS }).notNull(),
    name: text("name").notNull(),
    status: text("status", { enum: SALES_CHANNEL_STATUSES }).notNull().default("draft"),
    subsidiaryId: uuid("subsidiary_id"),
    currency: currencyCode("currency").notNull(),
    externalAccount: text("external_account").notNull(),
    secrets: text("secrets"),
    webhookSecret: text("webhook_secret"),
    settings: jsonb("settings").notNull().default({}),
    health: jsonb("health").notNull().default({}),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("sales_channels_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("sales_channels_kind_account_unique").on(t.orgId, t.kind, t.externalAccount),
    check("sales_channels_kind_valid", sql`${t.kind} in ('shopify')`),
    check(
      "sales_channels_status_valid",
      sql`${t.status} in ('draft', 'connecting', 'active', 'paused', 'disconnected', 'error')`,
    ),
    check("sales_channels_name_nonblank", sql`length(btrim(${t.name})) > 0`),
    check("sales_channels_currency_nonblank", sql`length(btrim(${t.currency})) > 0`),
    check(
      "sales_channels_external_account_nonblank",
      sql`length(btrim(${t.externalAccount})) > 0`,
    ),
    foreignKey({ name: "sales_channels_org_fk", columns: [t.orgId], foreignColumns: [orgs.id] }),
    foreignKey({
      name: "sales_channels_subsidiary_tenant_fk",
      columns: [t.orgId, t.subsidiaryId],
      foreignColumns: [subsidiaries.orgId, subsidiaries.id],
    }),
  ],
);

/** Effective-dated posting configuration per channel, role and key. */
export const salesChannelAccountMaps = pgTable(
  "sales_channel_account_maps",
  {
    id: id(),
    orgId: orgRef(),
    channelId: uuid("channel_id").notNull(),
    role: text("role", { enum: SALES_CHANNEL_ACCOUNT_ROLES }).notNull(),
    key: text("key").notNull().default(""),
    accountId: uuid("account_id").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("sales_channel_account_maps_org_id_id_unique").on(t.orgId, t.id),
    index("sales_channel_account_maps_lookup").on(
      t.orgId,
      t.channelId,
      t.role,
      t.key,
      t.effectiveFrom,
    ),
    check(
      "sales_channel_account_maps_role_valid",
      sql`${t.role} in ('gateway_clearing', 'revenue', 'discount', 'shipping_income', 'gift_card_liability', 'sales_tax_liability', 'rounding', 'refund_clearing')`,
    ),
    check(
      "sales_channel_account_maps_window_valid",
      sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
    foreignKey({
      name: "sales_channel_account_maps_org_fk",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }),
    foreignKey({
      name: "sales_channel_account_maps_channel_tenant_fk",
      columns: [t.orgId, t.channelId],
      foreignColumns: [salesChannels.orgId, salesChannels.id],
    }),
    foreignKey({
      name: "sales_channel_account_maps_account_tenant_fk",
      columns: [t.orgId, t.accountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
  ],
);

/** Storefront location to native stock location links. */
export const salesChannelLocations = pgTable(
  "sales_channel_locations",
  {
    id: id(),
    orgId: orgRef(),
    channelId: uuid("channel_id").notNull(),
    externalLocationId: text("external_location_id").notNull(),
    externalName: text("external_name").notNull(),
    stockLocationId: uuid("stock_location_id"),
    syncInventory: boolean("sync_inventory").notNull().default(true),
    fulfilsOrders: boolean("fulfils_orders").notNull().default(false),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("sales_channel_locations_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("sales_channel_locations_external_unique").on(
      t.orgId,
      t.channelId,
      t.externalLocationId,
    ),
    check(
      "sales_channel_locations_external_id_nonblank",
      sql`length(btrim(${t.externalLocationId})) > 0`,
    ),
    check(
      "sales_channel_locations_external_name_nonblank",
      sql`length(btrim(${t.externalName})) > 0`,
    ),
    foreignKey({
      name: "sales_channel_locations_org_fk",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }),
    foreignKey({
      name: "sales_channel_locations_channel_tenant_fk",
      columns: [t.orgId, t.channelId],
      foreignColumns: [salesChannels.orgId, salesChannels.id],
    }),
    foreignKey({
      name: "sales_channel_locations_stock_tenant_fk",
      columns: [t.orgId, t.stockLocationId],
      foreignColumns: [stockLocations.orgId, stockLocations.id],
    }),
  ],
);

/**
 * The single external-identity map. `native_id` is intentionally not a foreign
 * key: each object type targets a different native table, and customer identity
 * is an explicit link rather than an implicit party association.
 */
export const externalLinks = pgTable(
  "external_links",
  {
    id: id(),
    orgId: orgRef(),
    channelId: uuid("channel_id"),
    provider: text("provider", { enum: EXTERNAL_LINK_PROVIDERS }).notNull(),
    externalAccount: text("external_account").notNull(),
    objectType: text("object_type", { enum: EXTERNAL_LINK_OBJECT_TYPES }).notNull(),
    externalId: text("external_id").notNull(),
    externalParentId: text("external_parent_id"),
    nativeTable: text("native_table", { enum: EXTERNAL_LINK_NATIVE_TABLES }).notNull(),
    nativeId: uuid("native_id").notNull(),
    externalUpdatedAt: timestamp("external_updated_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("external_links_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("external_links_external_unique").on(
      t.orgId,
      t.provider,
      t.externalAccount,
      t.objectType,
      t.externalId,
    ),
    uniqueIndex("external_links_native_unique").on(
      t.orgId,
      t.provider,
      t.externalAccount,
      t.objectType,
      t.nativeId,
    ),
    check("external_links_provider_valid", sql`${t.provider} in ('shopify', 'stripe', 'chargebee', 'recurly', 'maxio', 'zuora')`),
    check(
      "external_links_object_type_valid",
      sql`${t.objectType} in ('product', 'variant', 'customer', 'order', 'refund', 'fulfillment', 'payout', 'location', 'gift_card', 'subscription', 'price', 'meter', 'subscription_item', 'invoice', 'credit_note', 'payment', 'coupon')`,
    ),
    check(
      "external_links_native_table_valid",
      sql`${t.nativeTable} in ('items', 'item_families', 'parties', 'documents', 'stock_locations', 'stored_value_accounts', 'subscriptions', 'subscription_items', 'subscription_usage_links', 'usage_meters', 'usage_rating_plan_versions', 'promotions')`,
    ),
    check(
      "external_links_account_nonblank",
      sql`length(btrim(${t.externalAccount})) > 0`,
    ),
    check(
      "external_links_external_id_nonblank",
      sql`length(btrim(${t.externalId})) > 0`,
    ),
    foreignKey({ name: "external_links_org_fk", columns: [t.orgId], foreignColumns: [orgs.id] }),
    foreignKey({
      name: "external_links_channel_tenant_fk",
      columns: [t.orgId, t.channelId],
      foreignColumns: [salesChannels.orgId, salesChannels.id],
    }),
  ],
);

/** Raw verified inbound webhook inbox, deduplicated by provider event id. */
export const integrationInboundEvents = pgTable(
  "integration_inbound_events",
  {
    id: id(),
    orgId: orgRef(),
    channelId: uuid("channel_id").notNull(),
    provider: text("provider").notNull(),
    topic: text("topic").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    rawBody: bytea("raw_body").notNull(),
    headers: jsonb("headers").notNull().default({}),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    verified: boolean("verified").notNull().default(false),
    status: text("status", { enum: INBOUND_EVENT_STATUSES }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    error: text("error"),
    resultRef: jsonb("result_ref"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("integration_inbound_events_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("integration_inbound_events_dedupe").on(t.channelId, t.providerEventId),
    index("integration_inbound_events_work_scan").on(t.status, t.nextAttemptAt),
    check("integration_inbound_events_topic_nonblank", sql`length(btrim(${t.topic})) > 0`),
    check(
      "integration_inbound_events_event_id_nonblank",
      sql`length(btrim(${t.providerEventId})) > 0`,
    ),
    check("integration_inbound_events_attempts_valid", sql`${t.attempts} >= 0`),
    check(
      "integration_inbound_events_status_valid",
      sql`${t.status} in ('pending', 'processing', 'processed', 'ignored', 'failed', 'dead')`,
    ),
    foreignKey({
      name: "integration_inbound_events_org_fk",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }),
    foreignKey({
      name: "integration_inbound_events_channel_tenant_fk",
      columns: [t.orgId, t.channelId],
      foreignColumns: [salesChannels.orgId, salesChannels.id],
    }),
  ],
);

export const SHOPIFY_CATALOG_OBJECT_TYPES = ["product", "variant"] as const;
export const SHOPIFY_CATALOG_STATUSES = ["queued", "matched", "ignored"] as const;

/** Shopify catalog match queue: one row per storefront product or variant with its match state. */
export const shopifyCatalogEntries = pgTable(
  "shopify_catalog_entries",
  {
    id: id(),
    orgId: orgRef(),
    channelId: uuid("channel_id").notNull(),
    objectType: text("object_type", { enum: SHOPIFY_CATALOG_OBJECT_TYPES }).notNull(),
    externalId: text("external_id").notNull(),
    externalParentId: text("external_parent_id"),
    title: text("title").notNull(),
    sku: text("sku"),
    barcode: text("barcode"),
    priceMinor: bigint("price_minor", { mode: "bigint" }),
    currency: currencyCode("currency").notNull().default(""),
    optionValues: jsonb("option_values").$type<Record<string, string>>().notNull().default({}),
    shopifyUpdatedAt: timestamp("shopify_updated_at", { withTimezone: true }),
    status: text("status", { enum: SHOPIFY_CATALOG_STATUSES }).notNull().default("queued"),
    nativeTable: text("native_table", { enum: ["items", "item_families"] }),
    nativeId: uuid("native_id"),
    ignoreReason: text("ignore_reason"),
    proposal: jsonb("proposal").$type<Record<string, unknown> | null>(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("shopify_catalog_entries_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("shopify_catalog_entries_external_unique").on(t.orgId, t.channelId, t.externalId),
    index("shopify_catalog_entries_queue").on(t.orgId, t.channelId, t.status),
    check(
      "shopify_catalog_entries_object_valid",
      sql`${t.objectType} in ('product', 'variant')`,
    ),
    check(
      "shopify_catalog_entries_status_valid",
      sql`${t.status} in ('queued', 'matched', 'ignored')`,
    ),
    check(
      "shopify_catalog_entries_external_id_nonblank",
      sql`length(btrim(${t.externalId})) > 0`,
    ),
    check("shopify_catalog_entries_title_nonblank", sql`length(btrim(${t.title})) > 0`),
    check(
      "shopify_catalog_entries_native_valid",
      sql`${t.nativeTable} is null or ${t.nativeTable} in ('items', 'item_families')`,
    ),
    check(
      "shopify_catalog_entries_match_valid",
      sql`(${t.status} = 'matched') = (${t.nativeTable} is not null and ${t.nativeId} is not null)`,
    ),
    foreignKey({
      name: "shopify_catalog_entries_org_fk",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }),
    foreignKey({
      name: "shopify_catalog_entries_channel_tenant_fk",
      columns: [t.orgId, t.channelId],
      foreignColumns: [salesChannels.orgId, salesChannels.id],
    }),
  ],
);
