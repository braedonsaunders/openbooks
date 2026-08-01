import { sql } from "drizzle-orm";
import {
  boolean,
  check,
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
import { auditColumns, id, money, orgRef } from "./helpers";

/**
 * A taxing jurisdiction — reference data, tenant-owned so packs and manual
 * setup can both populate it. Structured replacement for the loose country/
 * region text on tax codes and return forms: a country, an optional subdivision
 * (US state, Canadian province, German Land…), a `level` in the hierarchy, and
 * the kind of indirect tax it levies. `parentId` models the real nesting a
 * US sales-tax filer faces (country → state → county → city → special district)
 * so a city return can roll up to its state. This is the spine of the nexus
 * model: registrations point at jurisdictions, not free text.
 */
export const taxJurisdictions = pgTable(
  "tax_jurisdictions",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(), // "US-CA", "CA-ON", "DE", "US-CA-LA-CITY"
    name: text("name").notNull(), // "California", "Ontario", "Germany"
    country: text("country").notNull(), // ISO-3166-1 alpha-2, "US"
    region: text("region"), // subdivision, "CA" (state), "ON" (province)
    level: text("level", {
      enum: ["country", "state", "county", "city", "special", "federal"],
    })
      .notNull()
      .default("country"),
    /** The indirect tax this jurisdiction levies — drives which pack fits. */
    taxType: text("tax_type", {
      enum: [
        "vat",
        "gst",
        "hst",
        "pst",
        "qst",
        "sales_use",
        "consumption",
        "other",
      ],
    })
      .notNull()
      .default("other"),
    /** Self-reference: a city rolls up to its county/state/country. */
    parentId: uuid("parent_id"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("tax_jurisdictions_org_code").on(t.orgId, t.code),
    index("tax_jurisdictions_org_country").on(t.orgId, t.country),
    index("tax_jurisdictions_parent").on(t.parentId),
  ],
);

/** Immutable tenant evidence of the exact localization content installed. */
export const taxCountryPackInstallations = pgTable(
  "tax_country_pack_installations",
  {
    id: id(),
    orgId: orgRef(),
    packCode: text("pack_code").notNull(),
    country: text("country").notNull(),
    version: text("version").notNull(),
    contentHash: text("content_hash").notNull(),
    manifest: jsonb("manifest").notNull(),
    status: text("status", { enum: ["active", "superseded"] }).notNull().default("active"),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    installedBy: uuid("installed_by"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededBy: uuid("superseded_by"),
  },
  (t) => [
    uniqueIndex("tax_country_pack_installations_org_pack_version").on(t.orgId, t.packCode, t.version),
    uniqueIndex("tax_country_pack_installations_one_active").on(t.orgId, t.packCode).where(sql`${t.status} = 'active'`),
    index("tax_country_pack_installations_org_country").on(t.orgId, t.country),
    check("tax_country_pack_installations_identity", sql`
      ${t.packCode} <> ''
      and ${t.country} ~ '^[A-Z]{2}$'
      and ${t.version} ~ '^[0-9]{4}\.[0-9]{2}\.[0-9]{2}$'
      and ${t.contentHash} ~ '^[0-9a-f]{64}$'
    `),
    check("tax_country_pack_installations_manifest", sql`
      jsonb_typeof(${t.manifest}) = 'object'
      and ${t.manifest}->>'code' = ${t.packCode}
      and ${t.manifest}->>'country' = ${t.country}
      and ${t.manifest}->>'version' = ${t.version}
    `),
    check("tax_country_pack_installations_lifecycle", sql`
      (${t.status} = 'active' and ${t.supersededAt} is null and ${t.supersededBy} is null)
      or (${t.status} = 'superseded' and ${t.supersededAt} is not null)
    `),
  ],
);

/**
 * The org's nexus footprint: one row per jurisdiction the business is
 * registered to collect and remit in. This is what makes tax obligations
 * explicit (rather than inferred from whichever tax codes happen to exist) —
 * it carries the government registration number, the filing frequency, and
 * the return form that jurisdiction expects, so the engine can build a filing
 * calendar and answer "are we registered here?". Credentials never live here.
 */
export const taxRegistrations = pgTable(
  "tax_registrations",
  {
    id: id(),
    orgId: orgRef(),
    jurisdictionId: uuid("jurisdiction_id").notNull(),
    /** Government-issued registration/permit number (GST/VAT no., state permit). */
    registrationNumber: text("registration_number"),
    /** How often this jurisdiction expects a return. */
    filingFrequency: text("filing_frequency", {
      enum: ["monthly", "bimonthly", "quarterly", "semiannual", "annual"],
    })
      .notNull()
      .default("quarterly"),
    /** The return form this registration files — joins tax_return_forms.code. */
    returnFormCode: text("return_form_code"),
    effectiveFrom: date("effective_from"),
    effectiveTo: date("effective_to"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    index("tax_registrations_org").on(t.orgId),
    index("tax_registrations_jurisdiction").on(t.jurisdictionId),
  ],
);

/**
 * Tax codes with dated rates for jurisdiction-specific indirect-tax regimes.
 * Compound taxes are represented by tax groups that sum component codes.
 */
export const taxCodes = pgTable("tax_codes", {
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
});

export const taxRates = pgTable(
  "tax_rates",
  {
    id: id(),
    orgId: orgRef(),
    taxCodeId: uuid("tax_code_id").notNull(),
    ratePercent: money("rate_percent").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    ...auditColumns,
  },
  (t) => [index("tax_rates_code").on(t.taxCodeId)],
);

export const taxGroups = pgTable("tax_groups", {
  id: id(),
  orgId: orgRef(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  priceIncludesTax: boolean("price_includes_tax").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
});

export const taxGroupMembers = pgTable(
  "tax_group_members",
  {
    id: id(),
    taxGroupId: uuid("tax_group_id").notNull(),
    taxCodeId: uuid("tax_code_id").notNull(),
    sequence: integer("sequence").notNull().default(1),
  },
  (t) => [
    uniqueIndex("tax_group_members_code_unique").on(t.taxGroupId, t.taxCodeId),
    uniqueIndex("tax_group_members_sequence_unique").on(
      t.taxGroupId,
      t.sequence,
    ),
    check("tax_group_members_positive_sequence", sql`${t.sequence} > 0`),
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
 * A configurable government tax return, tenant-owned and UI-editable via the
 * Setup registry. openbooks computes the box values from the ledger, renders a
 * working copy, and routes filing through the channel the jurisdiction
 * mandates. New jurisdictions are versioned country-pack data (a form and its
 * boxes), not conditional application code. `code` matches
 * tax_report_lines.report_code (for example, "CA_GST34").
 */
export const taxReturnForms = pgTable("tax_return_forms", {
  id: id(),
  orgId: orgRef(),
  code: text("code").notNull(), // "CA_GST34" — joins tax_report_lines.report_code
  name: text("name").notNull(), // "GST/HST Return (GST34)"
  /** Structured jurisdiction ownership; country and region support indexed filtering. */
  jurisdictionId: uuid("jurisdiction_id"),
  country: text("country"), // "CA"
  region: text("region"),
  /**
   * How this jurisdiction actually accepts the return. Most governments are
   * digital-only (portal/upload/API) — the facsimile is always available as a
   * working copy / audit record, but only `print_pdf` jurisdictions can file on
   * paper. See docs on the tax-return architecture.
   */
  submissionChannel: text("submission_channel", {
    enum: ["print_pdf", "file_upload", "efile_api", "portal_manual"],
  })
    .notNull()
    .default("portal_manual"),
  /** What the government actually accepts; exports remain working papers unless
   *  the configured method explicitly supports a certified file or API. */
  governmentFormat: text("government_format", {
    enum: ["portal_entry", "certified_file", "api", "paper"],
  })
    .notNull()
    .default("portal_entry"),
  /** Public government filing/instructions page. Credentials never live here. */
  submissionUrl: text("submission_url"),
  /** Legally-required not-for-filing watermark on the facsimile (CRA/ATO/BMF). */
  watermark: text("watermark"),
  /**
   * Optional official fillable PDF (tenant-uploaded, never bundled — Crown
   * copyright / personalized forms / XFA make bundling wrong). When set,
   * openbooks fills its AcroForm fields (tax_report_lines.pdf_field) and flattens.
   */
  officialPdfFileId: uuid("official_pdf_file_id"),
  isActive: boolean("is_active").notNull().default(true),
  ...auditColumns,
});

export interface TaxFilingSnapshotBox {
  lineCode: string;
  label: string;
  value: string;
  computed: boolean;
  editable: boolean;
}

/**
 * Immutable computed return snapshots. Preparing again creates a new version;
 * filing only adds the submission timestamp/reference. This preserves exactly
 * what a user relied on even if tax mappings or ledger data later change.
 */
export const taxFilings = pgTable(
  "tax_filings",
  {
    id: id(),
    orgId: orgRef(),
    formCode: text("form_code").notNull(),
    formName: text("form_name").notNull(),
    country: text("country"),
    periodFrom: date("period_from").notNull(),
    periodTo: date("period_to").notNull(),
    version: integer("version").notNull(),
    status: text("status", { enum: ["prepared", "filed"] })
      .notNull()
      .default("prepared"),
    submissionChannel: text("submission_channel").notNull(),
    boxes: jsonb("boxes").$type<TaxFilingSnapshotBox[]>().notNull(),
    adjustments: jsonb("adjustments")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    snapshotHash: text("snapshot_hash").notNull(),
    filingReference: text("filing_reference"),
    filedAt: timestamp("filed_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("tax_filings_period_version").on(
      t.orgId,
      t.formCode,
      t.periodFrom,
      t.periodTo,
      t.version,
    ),
    index("tax_filings_org_period").on(t.orgId, t.periodTo),
    index("tax_filings_org_status").on(t.orgId, t.status),
    check("tax_filings_dates_check", sql`${t.periodFrom} <= ${t.periodTo}`),
    check("tax_filings_version_check", sql`${t.version} > 0`),
    check("tax_filings_boxes_check", sql`jsonb_typeof(${t.boxes}) = 'array'`),
  ],
);

/**
 * Maps GL activity to tax return lines (GST34: line 101 sales, 103 collected,
 * 106 ITCs…). Replaces source platform's Tax Report Mapper custom record. A box is
 * either GL-mapped (tax code + basis) or COMPUTED (an arithmetic `formula` over
 * other line codes, e.g. line 109 = "105 - 108"). Both are UI-editable.
 */
export const taxReportLines = pgTable("tax_report_lines", {
  id: id(),
  orgId: orgRef(),
  reportCode: text("report_code").notNull(), // "CA_GST34"
  lineCode: text("line_code").notNull(), // "101"
  label: text("label").notNull(),
  taxCodeId: uuid("tax_code_id"),
  /**
   * How a GL-mapped box sums the ledger (null for computed/manual boxes):
   *  - tax_collected: tax on the code's collected (liability) account — output tax;
   *  - tax_paid: tax on the code's paid (recoverable) account — input tax credits;
   *  - tax_amount: every tax line for the code (no collected/paid split);
   *  - taxable_base: the base amount the tax applied to.
   */
  basis: text("basis", {
    enum: ["tax_collected", "tax_paid", "tax_amount", "taxable_base"],
  }),
  sign: integer("sign").notNull().default(1),
  /** Presentation + evaluation order within the form. */
  sequence: integer("sequence").notNull().default(0),
  /** Computed box: arithmetic over sibling line codes (e.g. "105 - 108"). When
   *  set, the box is derived from other boxes instead of GL activity. */
  formula: text("formula"),
  /** Official-PDF overlay: the AcroForm field this box fills (optional). */
  pdfField: text("pdf_field"),
  ...auditColumns,
});
