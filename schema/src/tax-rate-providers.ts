import { boolean, date, index, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { auditColumns, id, money, orgRef } from "./helpers";

/**
 * External sales-tax rate providers (Avalara AvaTax, TaxJar, or a custom HTTP
 * hook). Quotes are cached for audit evidence; the provider never posts GL —
 * tax is still projected through the kernel via document_line_tax_components.
 */
export const taxRateProviderConfigs = pgTable(
  "tax_rate_provider_configs",
  {
    id: id(),
    orgId: orgRef(),
    provider: text("provider", { enum: ["avalara", "taxjar", "custom_http", "manual"] }).notNull(),
    displayName: text("display_name").notNull(),
    isEnabled: boolean("is_enabled").notNull().default(false),
    /** Avalara: companyCode. TaxJar: none. custom_http: base URL. */
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    /** Sealed JSON credentials (apiKey, accountId, licenseKey, …). */
    secrets: text("secrets"),
    /** Prefer provider over local tax_codes when address is resolvable. */
    preferProvider: boolean("prefer_provider").notNull().default(true),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastError: text("last_error"),
    ...auditColumns,
  },
  (t) => [uniqueIndex("tax_rate_provider_configs_org").on(t.orgId)],
);

/** Immutable quote evidence for a ship-to / bill-from resolution. */
export const taxRateQuotes = pgTable(
  "tax_rate_quotes",
  {
    id: id(),
    orgId: orgRef(),
    providerConfigId: uuid("provider_config_id").notNull(),
    provider: text("provider").notNull(),
    quotedOn: date("quoted_on").notNull(),
    currency: text("currency"),
    shipFrom: jsonb("ship_from").$type<Record<string, string | null>>().notNull().default({}),
    shipTo: jsonb("ship_to").$type<Record<string, string | null>>().notNull().default({}),
    taxableAmount: money("taxable_amount").notNull(),
    taxAmount: money("tax_amount").notNull(),
    /** Component breakdown as returned by the provider. */
    components: jsonb("components")
      .$type<{ jurisdiction: string; ratePercent: string; taxAmount: string; taxName?: string }[]>()
      .notNull()
      .default([]),
    /** External transaction / quote id for refund linkage. */
    externalRef: text("external_ref"),
    documentLineId: uuid("document_line_id"),
    rawPayload: jsonb("raw_payload").$type<Record<string, unknown>>(),
    ...auditColumns,
  },
  (t) => [
    index("tax_rate_quotes_org_date").on(t.orgId, t.quotedOn),
    index("tax_rate_quotes_line").on(t.documentLineId),
  ],
);

/**
 * Locale pack metadata beyond return forms — e-file channels, reduced-rate
 * band codes, and MTD / BAS digital submission flags.
 */
export const taxLocalePackMeta = pgTable(
  "tax_locale_pack_meta",
  {
    id: id(),
    orgId: orgRef(),
    packCode: text("pack_code").notNull(),
    country: text("country").notNull(),
    /** e.g. uk_mtd_vat, au_sbr, ca_gst34, us_streamlined */
    filingChannel: text("filing_channel"),
    digitalSubmissionReady: boolean("digital_submission_ready").notNull().default(false),
    /** Rate band codes seeded with the pack (reduced, zero, exempt). */
    rateBands: jsonb("rate_bands").$type<{ code: string; name: string; ratePercent: number }[]>().notNull().default([]),
    notes: text("notes"),
    ...auditColumns,
  },
  (t) => [uniqueIndex("tax_locale_pack_meta_org_pack").on(t.orgId, t.packCode)],
);
