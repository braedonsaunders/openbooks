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
 * Tax codes with dated rates. Canada-first (GST/HST/PST, ITC recoverability)
 * but jurisdiction-generic. Compound provincial cases (QST-on-GST legacy)
 * handled via tax groups summing component codes.
 */
export const taxCodes = pgTable("tax_codes", {
  id: id(),
  orgId: orgRef(),
  code: text("code").notNull(), // "HST-ON", "GST", "EXEMPT"
  name: text("name").notNull(),
  country: text("country"),
  region: text("region"),
  appliesTo: text("applies_to", { enum: ["sales", "purchases", "both"] }).notNull().default("both"),
  collectedAccountId: uuid("collected_account_id"), // liability (sales tax collected)
  paidAccountId: uuid("paid_account_id"), // recoverable ITC asset
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
  isActive: boolean("is_active").notNull().default(true),
});

export const taxGroupMembers = pgTable("tax_group_members", {
  id: id(),
  taxGroupId: uuid("tax_group_id").notNull(),
  taxCodeId: uuid("tax_code_id").notNull(),
  sequence: integer("sequence").notNull().default(1),
});

/**
 * A configurable government tax return, tenant-owned and UI-editable via the
 * Setup registry. openbooks computes the box values from the ledger, renders a
 * faithful facsimile (works for every jurisdiction), and routes filing through
 * the channel the jurisdiction actually mandates. The filing method
 * Reporting Framework works. New jurisdictions are DATA (a form + its boxes),
 * not code. `code` matches tax_report_lines.report_code (e.g. "CA_GST34").
 */
export const taxReturnForms = pgTable("tax_return_forms", {
  id: id(),
  orgId: orgRef(),
  code: text("code").notNull(), // "CA_GST34" — joins tax_report_lines.report_code
  name: text("name").notNull(), // "GST/HST Return (GST34)"
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
    status: text("status", { enum: ["prepared", "filed"] }).notNull().default("prepared"),
    submissionChannel: text("submission_channel").notNull(),
    boxes: jsonb("boxes").$type<TaxFilingSnapshotBox[]>().notNull(),
    adjustments: jsonb("adjustments").$type<Record<string, string>>().notNull().default({}),
    snapshotHash: text("snapshot_hash").notNull(),
    filingReference: text("filing_reference"),
    filedAt: timestamp("filed_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("tax_filings_period_version").on(t.orgId, t.formCode, t.periodFrom, t.periodTo, t.version),
    index("tax_filings_org_period").on(t.orgId, t.periodTo),
    index("tax_filings_org_status").on(t.orgId, t.status),
    check("tax_filings_dates_check", sql`${t.periodFrom} <= ${t.periodTo}`),
    check("tax_filings_version_check", sql`${t.version} > 0`),
    check("tax_filings_boxes_check", sql`jsonb_typeof(${t.boxes}) = 'array'`),
  ],
);

/**
 * Maps GL activity to tax return lines (GST34: line 101 sales, 103 collected,
 * 106 ITCs…). A box is
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
  basis: text("basis", { enum: ["tax_collected", "tax_paid", "tax_amount", "taxable_base"] }),
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
