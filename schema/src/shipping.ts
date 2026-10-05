import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * Native carrier hub (migration 0504). Aggregator accounts (EasyPost,
 * Shippo) hold sealed credentials; package presets and org-wide posting and
 * rating defaults live in Setup; each bought label keeps its provider
 * identity, tracking state, and cost evidence; short-lived rate quotes make
 * bulk buying and previews cheap; carrier billing adjustments accrue against
 * the same label they correct.
 */

export const SHIPPING_PROVIDERS = ["easypost", "shippo"] as const;
export type ShippingProvider = (typeof SHIPPING_PROVIDERS)[number];

export const SHIPPING_ACCOUNT_MODES = ["test", "live"] as const;
export const SHIPPING_ACCOUNT_STATUSES = ["active", "disabled", "error"] as const;

export const PACKAGE_DIM_UNITS = ["cm", "in"] as const;
export const PACKAGE_WEIGHT_UNITS = ["g", "kg", "oz", "lb"] as const;

export const SHIPPING_RATE_RULES = ["cheapest", "fastest", "cheapest_by_date"] as const;
export type ShippingRateRule = (typeof SHIPPING_RATE_RULES)[number];

export const SHIPPING_LABEL_STATUSES = ["purchased", "voided", "refunded"] as const;
export type ShippingLabelStatus = (typeof SHIPPING_LABEL_STATUSES)[number];

export const SHIPPING_TRACKING_STATUSES = [
  "unknown",
  "pre_transit",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "exception",
  "returned",
  "cancelled",
] as const;
export type ShippingTrackingStatus = (typeof SHIPPING_TRACKING_STATUSES)[number];

export const SHIPPING_ADJUSTMENT_KINDS = [
  "weight_correction",
  "dimension_correction",
  "address_correction",
  "fuel",
  "duplicate",
  "other",
] as const;
export const SHIPPING_ADJUSTMENT_STATUSES = ["pending", "posted", "disputed"] as const;

export const shippingAccounts = pgTable(
  "shipping_accounts",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    provider: text("provider", { enum: SHIPPING_PROVIDERS }).notNull(),
    mode: text("mode", { enum: SHIPPING_ACCOUNT_MODES }).notNull().default("test"),
    status: text("status", { enum: SHIPPING_ACCOUNT_STATUSES }).notNull().default("active"),
    isDefault: boolean("is_default").notNull().default(false),
    /** Sealed JSON credential ({ apiKey }) — purpose `shipping.account.secrets`. */
    secrets: text("secrets"),
    /** Sealed relay secret authenticating inbound tracker deliveries. */
    webhookSecret: text("webhook_secret"),
    lastError: text("last_error"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("shipping_accounts_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("shipping_accounts_org_name_unique").on(t.orgId, t.name),
    uniqueIndex("shipping_accounts_org_default_unique").on(t.orgId).where(sql`${t.isDefault}`),
    check("shipping_accounts_name_nonblank", sql`length(btrim(${t.name})) > 0`),
  ],
);

export interface PackageDimensions {
  length: string | null;
  width: string | null;
  height: string | null;
  unit: "cm" | "in";
}

export const packagePresets = pgTable(
  "package_presets",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    length: numeric("length", { precision: 19, scale: 4 }),
    width: numeric("width", { precision: 19, scale: 4 }),
    height: numeric("height", { precision: 19, scale: 4 }),
    dimUnit: text("dim_unit", { enum: PACKAGE_DIM_UNITS }).notNull().default("cm"),
    weight: numeric("weight", { precision: 19, scale: 4 }),
    weightUnit: text("weight_unit", { enum: PACKAGE_WEIGHT_UNITS }).notNull().default("kg"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("package_presets_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("package_presets_org_name_unique").on(t.orgId, t.name),
    uniqueIndex("package_presets_org_default_unique").on(t.orgId).where(sql`${t.isDefault}`),
    check("package_presets_name_nonblank", sql`length(btrim(${t.name})) > 0`),
  ],
);

export interface ShippingCustomsDefaults {
  contentsType?: "merchandise" | "gift" | "documents" | "returned_goods" | null;
  contentsExplanation?: string | null;
  eelPfc?: string | null;
  exporterTaxId?: string | null;
  signer?: string | null;
}

export const shippingSettings = pgTable(
  "shipping_settings",
  {
    id: id(),
    orgId: orgRef(),
    shippingExpenseAccountId: uuid("shipping_expense_account_id"),
    carrierPayableAccountId: uuid("carrier_payable_account_id"),
    defaultAccountId: uuid("default_account_id"),
    defaultPresetId: uuid("default_preset_id"),
    defaultRateRule: text("default_rate_rule", { enum: SHIPPING_RATE_RULES }).notNull().default("cheapest"),
    /** Markup applied on top of the carrier rate, in basis points. */
    markupBps: integer("markup_bps").notNull().default(0),
    defaultInsurance: text("default_insurance", { enum: ["none", "carrier_full"] }).notNull().default("none"),
    defaultSignature: text("default_signature", { enum: ["none", "direct", "adult"] }).notNull().default("none"),
    customsDefaults: jsonb("customs_defaults").$type<ShippingCustomsDefaults>().notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("shipping_settings_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("shipping_settings_org_singleton").on(t.orgId),
    check("shipping_settings_markup_nonnegative", sql`${t.markupBps} >= 0`),
  ],
);

export interface ShippingTrackingEvent {
  /** Provider event id — tracker deliveries dedupe on this. */
  id: string | null;
  status: string;
  detail: string | null;
  occurredAt: string | null;
}

export const shipmentLabels = pgTable(
  "shipment_labels",
  {
    id: id(),
    orgId: orgRef(),
    shipmentDocumentId: uuid("shipment_document_id").notNull(),
    orderDocumentId: uuid("order_document_id"),
    accountId: uuid("account_id").notNull(),
    provider: text("provider", { enum: SHIPPING_PROVIDERS }).notNull(),
    providerShipmentId: text("provider_shipment_id").notNull(),
    providerRateId: text("provider_rate_id").notNull(),
    providerLabelId: text("provider_label_id"),
    carrier: text("carrier").notNull(),
    service: text("service").notNull(),
    /** Carrier charge in the rate currency's minor units — never floats. */
    rateMinor: bigint("rate_minor", { mode: "bigint" }).notNull(),
    rateCurrency: text("rate_currency").notNull(),
    labelUrl: text("label_url"),
    labelFileId: uuid("label_file_id"),
    trackingNumber: text("tracking_number"),
    trackingStatus: text("tracking_status", { enum: SHIPPING_TRACKING_STATUSES }).notNull().default("unknown"),
    events: jsonb("events").$type<ShippingTrackingEvent[]>().notNull().default([]),
    status: text("status", { enum: SHIPPING_LABEL_STATUSES }).notNull().default("purchased"),
    costEntryId: uuid("cost_entry_id"),
    purchasedAt: timestamp("purchased_at", { withTimezone: true }).notNull().defaultNow(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("shipment_labels_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("shipment_labels_live_rate_unique")
      .on(t.orgId, t.shipmentDocumentId, t.providerRateId)
      .where(sql`${t.status} = 'purchased'`),
    index("shipment_labels_org_shipment").on(t.orgId, t.shipmentDocumentId),
  ],
);

export interface NormalizedShippingRate {
  providerRateId: string;
  carrier: string;
  service: string;
  /** Decimal amount string in the rate currency (at most 4 places). */
  amount: string;
  currency: string;
  /** ISO delivery estimate when the provider quotes one. */
  deliveryDate: string | null;
  deliveryDays: number | null;
}

export const shippingRateQuotes = pgTable(
  "shipping_rate_quotes",
  {
    id: id(),
    orgId: orgRef(),
    shipmentDocumentId: uuid("shipment_document_id").notNull(),
    accountId: uuid("account_id").notNull(),
    requestHash: text("request_hash").notNull(),
    rates: jsonb("rates").$type<NormalizedShippingRate[]>().notNull().default([]),
    quotedAt: timestamp("quoted_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("shipping_rate_quotes_org_id_id_unique").on(t.orgId, t.id),
    index("shipping_rate_quotes_org_lookup").on(t.orgId, t.shipmentDocumentId, t.requestHash),
  ],
);

export const shippingAdjustments = pgTable(
  "shipping_adjustments",
  {
    id: id(),
    orgId: orgRef(),
    labelId: uuid("label_id").notNull(),
    providerAdjustmentId: text("provider_adjustment_id").notNull(),
    kind: text("kind", { enum: SHIPPING_ADJUSTMENT_KINDS }).notNull(),
    /** Signed minor units in `currency`: positive = extra charge. */
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    reason: text("reason"),
    status: text("status", { enum: SHIPPING_ADJUSTMENT_STATUSES }).notNull().default("pending"),
    entryId: uuid("entry_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("shipping_adjustments_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("shipping_adjustments_provider_identity").on(t.orgId, t.providerAdjustmentId),
    index("shipping_adjustments_org_label").on(t.orgId, t.labelId),
  ],
);

export type ShippingAccountRow = typeof shippingAccounts.$inferSelect;
export type PackagePresetRow = typeof packagePresets.$inferSelect;
export type ShippingSettingsRow = typeof shippingSettings.$inferSelect;
export type ShipmentLabelRow = typeof shipmentLabels.$inferSelect;
export type ShippingRateQuoteRow = typeof shippingRateQuotes.$inferSelect;
export type ShippingAdjustmentRow = typeof shippingAdjustments.$inferSelect;
