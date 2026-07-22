import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, currencyCode, fxRate, id, money, orgRef } from "./helpers";
import type { InvoicingPreference } from "./project-types";

/**
 * An org is a tenant: one sealed data space, one login
 * realm, one RLS boundary. Legal entities that keep books live INSIDE it as
 * subsidiaries (subsidiaries.ts, the multi-entity model); every org has
 * exactly one root subsidiary and single-subsidiary orgs see no subsidiary UI.
 * `baseCurrency`/`country` remain as the root subsidiary's defaults and the
 * tenant-level fallback.
 */
export const orgs = pgTable("orgs", {
  id: id(),
  name: text("name").notNull(),
  legalName: text("legal_name"),
  baseCurrency: currencyCode("base_currency").notNull(),
  country: text("country").notNull(), // ISO 3166-1 alpha-2
  taxIds: jsonb("tax_ids").$type<Record<string, string>>().default({}), // e.g. { "CA_BN": "..." }
  settings: jsonb("settings").notNull().default({ defaultNavMode: "topbar" }),
  /**
   * Environment kind. `production` is the live book. `sandbox` is a clone of a
   * production org (created by the rebase clone engine) — isolated, with all
   * outbound side-effects neutered. `preview` is reserved for next-release
   * validation copies. `sandboxOf` points a sandbox at its production parent
   * (distinct from `parentId`, which is the consolidation hierarchy).
   * `sandboxSeed` is the namespace fed to ob_rebase() so every UUID in this
   * environment is a deterministic rebase of its production counterpart.
   */
  envKind: text("env_kind", { enum: ["production", "sandbox", "preview"] })
    .notNull()
    .default("production"),
  sandboxOf: uuid("sandbox_of"),
  sandboxSeed: uuid("sandbox_seed"),
  ...auditColumns,
});

/**
 * Accounting books — primary, tax, IFRS, … Every journal entry belongs to
 * exactly one book; schedules (depreciation, rev rec) are book-aware.
 */
export const accountingBooks = pgTable(
  "accounting_books",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(), // "primary", "tax", "ifrs"
    name: text("name").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    /** Accounting books post GL journals; alternate/reporting books compute
     *  schedules without posting (multi-book depreciation). */
    postsGl: boolean("posts_gl").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [uniqueIndex("books_org_code").on(t.orgId, t.code)],
);

/**
 * Intercompany relationships: the due-to/due-from account pair used to
 * auto-balance postings that span two subsidiaries, and elimination in
 * consolidation. Both accounts should be flagged `accounts.eliminate`.
 */
export const intercompanyPairs = pgTable(
  "intercompany_pairs",
  {
    id: id(),
    orgId: orgRef(),
    fromSubsidiaryId: uuid("from_subsidiary_id").notNull(),
    toSubsidiaryId: uuid("to_subsidiary_id").notNull(),
    dueFromAccountId: uuid("due_from_account_id").notNull(), // asset on from-subsidiary
    dueToAccountId: uuid("due_to_account_id").notNull(), // liability on to-subsidiary
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [uniqueIndex("intercompany_subsidiary_pair").on(t.fromSubsidiaryId, t.toSubsidiaryId)],
);

export const currencies = pgTable("currencies", {
  code: currencyCode("code").primaryKey(), // ISO 4217
  name: text("name").notNull(),
  minorUnits: integer("minor_units").notNull().default(2),
});

export const fxRates = pgTable(
  "fx_rates",
  {
    id: id(),
    /** Tenant-owned rate table; rates and manual overrides never cross orgs. */
    orgId: orgRef(),
    fromCurrency: currencyCode("from_currency").notNull(),
    toCurrency: currencyCode("to_currency").notNull(),
    asOf: date("as_of").notNull(),
    /**
     * spot: transaction-date rate. average / historical: period rates for
     * consolidation translation (P&L at average, equity at historical).
     */
    rateType: text("rate_type", { enum: ["spot", "average", "historical"] })
      .notNull()
      .default("spot"),
    rate: fxRate("rate").notNull(),
    source: text("source").notNull().default("manual"),
    /** Null for manual overrides; set for automatic feed observations. */
    providerConfigId: uuid("provider_config_id"),
    importedAt: timestamp("imported_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("fx_rates_org_pair_date_type").on(t.orgId, t.fromCurrency, t.toCurrency, t.asOf, t.rateType),
  ],
);

/**
 * Accounting periods with per-module close — closing AP doesn't block GL
 * adjustments. Periods derive from a fiscal calendar; adjustment periods
 * (13th period) are supported via `isAdjustment`.
 */
export const accountingPeriods = pgTable(
  "accounting_periods",
  {
    id: id(),
    orgId: orgRef(),
    fiscalCalendarId: uuid("fiscal_calendar_id").notNull(),
    fiscalYear: integer("fiscal_year").notNull(),
    periodNumber: integer("period_number").notNull(), // 1..13
    name: text("name").notNull(), // "2026-07", "FY26 ADJ"
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on").notNull(),
    isAdjustment: boolean("is_adjustment").notNull().default(false),
    ...auditColumns,
  },
  (t) => [uniqueIndex("periods_calendar_year_num").on(t.orgId, t.fiscalCalendarId, t.fiscalYear, t.periodNumber)],
);

/**
 * Document numbering. Default mode allocates from a Postgres sequence
 * (fast, may gap on rollback); gapless mode locks the row and increments
 * (correct, serialized) for jurisdictions that require it.
 */
export const numberSequences = pgTable(
  "number_sequences",
  {
    id: id(),
    orgId: orgRef(),
    documentKind: text("document_kind").notNull(),
    /** Per-subsidiary numbering when set; null = the org-wide sequence. */
    subsidiaryId: uuid("subsidiary_id"),
    prefix: text("prefix").notNull().default(""),
    nextNumber: integer("next_number").notNull().default(1),
    padding: integer("padding").notNull().default(5),
    gapless: boolean("gapless").notNull().default(false),
    ...auditColumns,
  },
  (t) => [
    unique("sequences_org_kind_sub").on(t.orgId, t.documentKind, t.subsidiaryId).nullsNotDistinct(),
  ],
);

// ---------------------------------------------------------------------------
// Dimensions use one uniform mechanism. All are hierarchical
// where it matters and all are optional per line — enablement is UI config,
// never schema.
// ---------------------------------------------------------------------------

const dimensionColumns = {
  id: id(),
  orgId: orgRef(),
  parentId: uuid("parent_id"),
  code: text("code"),
  name: text("name").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  /** Restrict to one subsidiary('s subtree); null = usable in all. */
  subsidiaryId: uuid("subsidiary_id"),
  subsidiaryIncludeChildren: boolean("subsidiary_include_children").notNull().default(true),
  custom: jsonb("custom").notNull().default({}),
  ...auditColumns,
};

export const departments = pgTable("departments", dimensionColumns);
export const locations = pgTable("locations", dimensionColumns);
export const classes = pgTable("classes", dimensionColumns);

/**
 * Projects (jobs) are a core dimension supporting job costing, WIP, and
 * Account × Project reporting without bolt-on custom fields.
 */
export const projects = pgTable(
  "projects",
  {
    ...dimensionColumns,
    customerId: uuid("customer_id"), // → parties
    foremanId: uuid("foreman_id"), // → parties (employee role)
    managerId: uuid("manager_id"),
    status: text("status", {
      enum: ["quoted", "awarded", "active", "substantially_complete", "closed", "cancelled"],
    })
      .notNull()
      .default("active"),
    billingMethod: text("billing_method", {
      enum: ["time_and_materials", "fixed_price", "cost_plus"],
    }),
    // The configurable project type carrying the profitability/invoicing/backup
    // profiles. `billing_method` stays as a back-compat coarse classifier.
    projectTypeId: uuid("project_type_id"), // → project_types
    // Native invoicing/backup override for this project (cascades over the type
    // and customer). A first-class capability, not a user custom field.
    invoicingPreference: jsonb("invoicing_preference").$type<InvoicingPreference>(),
    customerPoNumber: text("customer_po_number"),
    /** Native fixed-price ceiling / transaction price used by project accounting. */
    contractValue: money("contract_value"),
    startsOn: date("starts_on"),
    endsOn: date("ends_on"),
    notes: text("notes"),
  },
  (t) => [index("projects_customer").on(t.customerId)],
);

/**
 * Corporate cards use a subledger instead of one GL account per card.
 * All cards post to one liability account; per-card
 * detail lives on journal lines via `payment_card_id`.
 */
export const paymentCards = pgTable("payment_cards", {
  id: id(),
  orgId: orgRef(),
  holderPartyId: uuid("holder_party_id").notNull(),
  liabilityAccountId: uuid("liability_account_id").notNull(),
  label: text("label").notNull(), // "Visa …4821 — K. Laroche"
  lastFour: text("last_four"),
  network: text("network"),
  isActive: boolean("is_active").notNull().default(true),
  ...auditColumns,
});
