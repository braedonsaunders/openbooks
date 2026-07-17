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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, currencyCode, fxRate, id, orgRef } from "./helpers";

/**
 * An org is a legal entity that keeps books (NetSuite: subsidiary).
 * Single-org installs have exactly one row. Hierarchy supports consolidation.
 */
export const orgs = pgTable("orgs", {
  id: id(),
  parentId: uuid("parent_id"),
  name: text("name").notNull(),
  legalName: text("legal_name"),
  baseCurrency: currencyCode("base_currency").notNull(),
  country: text("country").notNull(), // ISO 3166-1 alpha-2
  taxIds: jsonb("tax_ids").$type<Record<string, string>>().default({}), // e.g. { "CA_BN": "..." }
  isElimination: boolean("is_elimination").notNull().default(false),
  settings: jsonb("settings").notNull().default({}),
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
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [uniqueIndex("books_org_code").on(t.orgId, t.code)],
);

/**
 * Intercompany relationships: the due-to/due-from account pair used to
 * auto-balance cross-org postings, and elimination in consolidation.
 */
export const intercompanyPairs = pgTable(
  "intercompany_pairs",
  {
    id: id(),
    fromOrgId: uuid("from_org_id").notNull(),
    toOrgId: uuid("to_org_id").notNull(),
    dueFromAccountId: uuid("due_from_account_id").notNull(), // asset on from-org
    dueToAccountId: uuid("due_to_account_id").notNull(), // liability on to-org
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [uniqueIndex("intercompany_org_pair").on(t.fromOrgId, t.toOrgId)],
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
    fiscalYear: integer("fiscal_year").notNull(),
    periodNumber: integer("period_number").notNull(), // 1..13
    name: text("name").notNull(), // "2026-07", "FY26 ADJ"
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on").notNull(),
    isAdjustment: boolean("is_adjustment").notNull().default(false),
    // module-level close; null = open, timestamp = closed at
    arClosedAt: timestamp("ar_closed_at", { withTimezone: true }),
    apClosedAt: timestamp("ap_closed_at", { withTimezone: true }),
    glClosedAt: timestamp("gl_closed_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [uniqueIndex("periods_org_year_num").on(t.orgId, t.fiscalYear, t.periodNumber)],
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
    prefix: text("prefix").notNull().default(""),
    nextNumber: integer("next_number").notNull().default(1),
    padding: integer("padding").notNull().default(5),
    gapless: boolean("gapless").notNull().default(false),
    ...auditColumns,
  },
  (t) => [uniqueIndex("sequences_org_kind").on(t.orgId, t.documentKind)],
);

// ---------------------------------------------------------------------------
// Dimensions. One uniform mechanism (NetSuite has four). All are hierarchical
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
  custom: jsonb("custom").notNull().default({}),
  ...auditColumns,
};

export const departments = pgTable("departments", dimensionColumns);
export const locations = pgTable("locations", dimensionColumns);
export const classes = pgTable("classes", dimensionColumns);

/**
 * Projects (jobs) — promoted to a core dimension. The NetSuite extraction
 * shows this is the center of the business (job costing, WIP, Account ×
 * Project reporting) implemented there via bolt-on custom fields.
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
    customerPoNumber: text("customer_po_number"),
    startsOn: date("starts_on"),
    endsOn: date("ends_on"),
    notes: text("notes"),
  },
  (t) => [index("projects_customer").on(t.customerId)],
);

/**
 * Corporate cards as a subledger — replaces NetSuite's 67 one-GL-account-
 * per-card pattern. All cards post to one liability account; per-card
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
