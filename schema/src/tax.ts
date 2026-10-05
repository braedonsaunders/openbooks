import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";
import { auditColumns, id, money, orgRef } from "./helpers";

/**
 * Tax codes with dated rates for jurisdiction-specific indirect-tax regimes.
 * Compound taxes are represented by tax groups that sum component codes.
 */
export const taxCodes = pgTable(
  "tax_codes",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(), // "HST-ON", "GST", "EXEMPT"
    name: text("name").notNull(),
    /** Structured jurisdiction ownership. Country and region are denormalized for indexed filtering. */
    jurisdictionId: uuid("jurisdiction_id"),
    country: text("country"),
    region: text("region"),
    appliesTo: text("applies_to", { enum: ["sales", "purchases", "both"] })
      .notNull()
      .default("both"),
    collectedAccountId: uuid("collected_account_id"), // liability (sales tax collected)
    paidAccountId: uuid("paid_account_id"), // recoverable ITC asset
    /** How the component affects settlement and GL projection. */
    calculationType: text("calculation_type", {
      enum: ["standard", "withholding", "reverse_charge"],
    })
      .notNull()
      .default("standard"),
    /** Withholding receivable/payable account; standard/reverse use paid/collected. */
    withholdingAccountId: uuid("withholding_account_id"),
    /** Standalone-code price entry includes this tax. Groups own their inclusive flag. */
    priceIncludesTax: boolean("price_includes_tax").notNull().default(false),
    /** This component's basis includes earlier non-withholding group components. */
    compoundOnPrevious: boolean("compound_on_previous").notNull().default(false),
    /** Statutory rounding precision, usually cents. */
    roundingScale: integer("rounding_scale").notNull().default(2),
    /** Non-recoverable portion is expensed to the line's account instead. */
    recoverablePercent: money("recoverable_percent").notNull().default("100"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("tax_codes_org_id_id_unique").on(t.orgId, t.id),
    // Mirrors migration 0042: one authoritative tax code per (org, code).
    unique("tax_codes_org_code_unique").on(t.orgId, t.code),
  ],
);

export const taxRates = pgTable(
  "tax_rates",
  {
    id: id(),
    orgId: orgRef(),
    taxCodeId: uuid("tax_code_id").notNull(),
    ratePercent: money("rate_percent").notNull(),
    /** Inclusive effective window start. Windows may not overlap within one
     *  org/tax-code identity (storage constraint 0024). */
    effectiveFrom: date("effective_from").notNull(),
    /** Inclusive end; null is open-ended. Windows may not overlap within one
     *  org/tax-code identity (storage constraint 0024). */
    effectiveTo: date("effective_to"),
    ...auditColumns,
  },
  (t) => [
    index("tax_rates_code").on(t.taxCodeId),
    // Mirrors migration 0042: the calculation engine (engine/src/tax/tax.ts)
    // refuses negative rates, so a negative rate can never be usable —
    // storage rejects it at the write boundary. A statutory 0% rate is legal.
    check("tax_rates_rate_percent_domain", sql`${t.ratePercent} >= 0`),
  ],
);

export const taxGroups = pgTable(
  "tax_groups",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    priceIncludesTax: boolean("price_includes_tax").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => [
    uniqueIndex("tax_groups_org_id_id_unique").on(t.orgId, t.id),
    // Mirrors migration 0042: one authoritative tax group per (org, code).
    unique("tax_groups_org_code_unique").on(t.orgId, t.code),
  ],
);

/**
 * Immutable-at-posting tax calculation evidence. A document line may expand a
 * tax group into several ordered component rows; rates, bases, recovery split,
 * calculation behavior, and resolved accounts are snapshotted so changing a
 * future rate/configuration never rewrites the historical tax explanation.
 */
export const documentLineTaxComponents = pgTable(
  "document_line_tax_components",
  {
    id: id(),
    orgId: orgRef(),
    documentLineId: uuid("document_line_id").notNull(),
    taxCodeId: uuid("tax_code_id").notNull(),
    sequence: integer("sequence").notNull(),
    ratePercent: money("rate_percent").notNull(),
    taxableAmount: money("taxable_amount").notNull(),
    taxAmount: money("tax_amount").notNull(),
    recoverableAmount: money("recoverable_amount").notNull().default("0"),
    nonrecoverableAmount: money("nonrecoverable_amount").notNull().default("0"),
    calculationType: text("calculation_type", {
      enum: ["standard", "withholding", "reverse_charge"],
    }).notNull(),
    priceIncludesTax: boolean("price_includes_tax").notNull().default(false),
    compoundOnPrevious: boolean("compound_on_previous")
      .notNull()
      .default(false),
    roundingScale: integer("rounding_scale").notNull().default(2),
    /**
     * Who collects this component's tax: the merchant (posts the liability)
     * or a marketplace facilitator (posts the facilitator clearing account,
     * kept for reporting and nexus but never the merchant's liability).
     * Inherited from the document line at calculation time.
     */
    collectedBy: text("collected_by", { enum: ["merchant", "marketplace"] })
      .notNull()
      .default("merchant"),
    /** Facilitator name (in marketplace_facilitators) when collected_by is marketplace. */
    facilitatorName: text("facilitator_name"),
    collectedAccountId: uuid("collected_account_id"),
    paidAccountId: uuid("paid_account_id"),
    withholdingAccountId: uuid("withholding_account_id"),
    overridden: boolean("overridden").notNull().default(false),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("document_line_tax_components_line_sequence").on(
      t.documentLineId,
      t.sequence,
    ),
    index("document_line_tax_components_code").on(t.orgId, t.taxCodeId),
    check(
      "document_line_tax_components_recovery_crossfoot",
      sql`${t.recoverableAmount} + ${t.nonrecoverableAmount} = ${t.taxAmount}`,
    ),
    check(
      "document_line_tax_components_rounding_scale",
      sql`${t.roundingScale} between 0 and 4`,
    ),
  ],
);

/**
 * Provider commit tracking for posted sales documents. The posting
 * transaction enqueues one row per provider and direction; the periodic
 * tax_provider_commit scan performs the provider call with retries and
 * records the outcome, including any provider/posted tax difference.
 */
export const taxProviderTransactions = pgTable(
  "tax_provider_transactions",
  {
    id: id(),
    orgId: orgRef(),
    documentId: uuid("document_id").notNull(),
    provider: text("provider", {
      enum: ["avalara", "taxjar", "custom_http"],
    }).notNull(),
    /** Document code sent to the provider (document number + org discriminator). */
    providerCode: text("provider_code").notNull(),
    kind: text("kind", { enum: ["sale", "return"] }).notNull(),
    status: text("status", {
      enum: ["pending", "committed", "voided", "failed", "skipped"],
    })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastError: text("last_error"),
    /** Set by the document void path; the scan voids the committed provider transaction. */
    voidRequestedAt: timestamp("void_requested_at", { withTimezone: true }),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    /** Bounded provider response evidence: totals, document code, mismatch. */
    providerResponseExcerpt: jsonb("provider_response_excerpt"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("tax_provider_transactions_org_id_id_unique").on(t.orgId, t.id),
    unique("tax_provider_transactions_document_unique").on(
      t.documentId,
      t.provider,
      t.kind,
    ),
    index("tax_provider_transactions_scan").on(t.status, t.nextAttemptAt),
  ],
);

/**
 * Marketplace facilitators collecting tax the merchant reports but never
 * owes. Their tax posts to the clearing account (settled through the
 * marketplace payout), never to the merchant's tax liability.
 */
export const marketplaceFacilitators = pgTable(
  "marketplace_facilitators",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    clearingAccountId: uuid("clearing_account_id").notNull(),
    /**
     * gross = the document total includes the marketplace tax and posting
     * credits the clearing account; net = the document is net of tax and
     * posting emits no leg for marketplace components.
     */
    collectionMode: text("collection_mode", { enum: ["gross", "net"] })
      .notNull()
      .default("gross"),
    /** State codes where this facilitator collects. */
    states: text("states").array().notNull().default([]),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("marketplace_facilitators_org_id_id_unique").on(t.orgId, t.id),
    unique("marketplace_facilitators_org_name_unique").on(t.orgId, t.name),
  ],
);

/**
 * One-Stop-Shop registrations: the member state of identification, scheme and
 * number the org files under. One active registration per scheme; a
 * re-registration closes the old window and opens a new row, so a filed
 * period always resolves to the registration that covered it.
 */
export const taxOssRegistrations = pgTable(
  "tax_oss_registrations",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id"),
    scheme: text("scheme", { enum: ["union", "non_union", "ioss"] }).notNull(),
    identificationState: text("identification_state").notNull(),
    registrationNumber: text("registration_number").notNull(),
    effectiveFrom: date("effective_from"),
    effectiveTo: date("effective_to"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("tax_oss_registrations_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("tax_oss_registrations_one_active_scheme")
      .on(t.orgId, t.scheme)
      .where(sql`${t.isActive}`),
    index("tax_oss_registrations_org_scheme").on(t.orgId, t.scheme),
  ],
);

/**
 * Validated business tax IDs per customer: the normalized number, which
 * authority checked it, the verdict, when it was checked, the authority's
 * consultation reference and a bounded excerpt of the authority response.
 * History is kept per value; a failed authority call leaves the previous
 * verdict with status unverified, never a silent pass.
 */
export const partyTaxIds = pgTable(
  "party_tax_ids",
  {
    id: id(),
    orgId: orgRef(),
    partyId: uuid("party_id").notNull(),
    scheme: text("scheme", { enum: ["vies", "hmrc", "abn", "gst"] }).notNull(),
    value: text("value").notNull(),
    status: text("status", { enum: ["valid", "invalid", "unverified"] })
      .notNull()
      .default("unverified"),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    checkedBy: uuid("checked_by"),
    consultationNumber: text("consultation_number"),
    responseExcerpt: jsonb("response_excerpt"),
    revalidateAfter: date("revalidate_after"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("party_tax_ids_org_id_id_unique").on(t.orgId, t.id),
    unique("party_tax_ids_identity_unique").on(
      t.orgId,
      t.partyId,
      t.scheme,
      t.value,
    ),
    index("party_tax_ids_org_party").on(t.orgId, t.partyId),
  ],
);

/**
 * Place-of-supply evidence per sales document: each independently collected
 * location signal with the country it asserts and the system that observed
 * it. Only derived country codes are stored — never raw IPs, PANs or BINs.
 */
export const documentSupplyEvidence = pgTable(
  "document_supply_evidence",
  {
    orgId: orgRef(),
    documentId: uuid("document_id").notNull(),
    kind: text("kind", {
      enum: [
        "billing_address",
        "ip_country",
        "card_bin_country",
        "bank_country",
        "sim_country",
        "ship_to",
      ],
    }).notNull(),
    countryCode: text("country_code").notNull(),
    source: text("source").notNull(),
    observedOn: date("observed_on"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: uuid("created_by"),
  },
  (t) => [
    index("document_supply_evidence_org_document").on(t.orgId, t.documentId),
  ],
);

/**
 * Whether a state's economic-nexus threshold counts marketplace-facilitated
 * sales. Global reference data: seeded only where the rule is cited; a state
 * with no row defaults to included pending review.
 */
export const marketplaceNexusStateRules = pgTable(
  "marketplace_nexus_state_rules",
  {
    state: text("state").primaryKey(),
    includeInThreshold: boolean("include_in_threshold")
      .notNull()
      .default(true),
    needsReview: boolean("needs_review").notNull().default(true),
    /** The cited source of a verified rule (publication or statute). */
    source: text("source").notNull().default(""),
  },
  () => [],
);

/**
 * Sealed tax-authority credentials per organization: the HMRC VAT API OAuth
 * client and tokens, and the ABN Lookup GUID. Secrets stay sealed at rest;
 * only connection status and failures are readable.
 */
export const taxAuthorityConnections = pgTable(
  "tax_authority_connections",
  {
    id: id(),
    orgId: orgRef(),
    authority: text("authority", { enum: ["hmrc", "abn"] }).notNull(),
    sealedCredentials: text("sealed_credentials"),
    status: text("status", {
      enum: ["missing", "ready", "error", "expired"],
    })
      .notNull()
      .default("missing"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("tax_authority_connections_org_id_id_unique").on(
      t.orgId,
      t.id,
    ),
    unique("tax_authority_connections_org_authority_unique").on(
      t.orgId,
      t.authority,
    ),
  ],
);

/**
 * ECB spot-rate evidence behind OSS returns translated into euro: one row
 * per return period and source currency with the rate date and the digest
 * that reproduces the filed figures after provider rows change.
 */
export const taxOssFxEvidence = pgTable(
  "tax_oss_fx_evidence",
  {
    id: id(),
    orgId: orgRef(),
    scheme: text("scheme", {
      enum: ["union", "non_union", "ioss"],
    }).notNull(),
    periodFrom: date("period_from").notNull(),
    periodTo: date("period_to").notNull(),
    currency: text("currency").notNull(),
    rate: numeric("rate").notNull(),
    rateAsOf: date("rate_as_of").notNull(),
    rateSource: text("rate_source").notNull(),
    evidenceDigest: text("evidence_digest").notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("tax_oss_fx_evidence_org_id_id_unique").on(t.orgId, t.id),
    unique("tax_oss_fx_evidence_period_currency_unique").on(
      t.orgId,
      t.scheme,
      t.periodFrom,
      t.periodTo,
      t.currency,
    ),
  ],
);
