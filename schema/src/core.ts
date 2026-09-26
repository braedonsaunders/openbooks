import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";
import { auditColumns, currencyCode, id, money, orgRef } from "./helpers";
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

export const currencies = pgTable("currencies", {
  code: currencyCode("code").primaryKey(), // ISO 4217
  name: text("name").notNull(),
  minorUnits: integer("minor_units").notNull().default(2),
});

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
    /** Stable connector identities (for example an external posting-period id).
     * A source transaction may post to a period other than the one containing
     * its transaction date, so migration must resolve the exact source period
     * instead of inferring it from a calendar month. */
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("accounting_periods_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("periods_calendar_year_num").on(t.orgId, t.fiscalCalendarId, t.fiscalYear, t.periodNumber),
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

export const departments = pgTable(
  "departments",
  dimensionColumns,
  (t) => [uniqueIndex("departments_org_id_id_unique").on(t.orgId, t.id)],
);
export const locations = pgTable(
  "locations",
  dimensionColumns,
  (t) => [uniqueIndex("locations_org_id_id_unique").on(t.orgId, t.id)],
);
export const classes = pgTable(
  "classes",
  dimensionColumns,
  (t) => [uniqueIndex("classes_org_id_id_unique").on(t.orgId, t.id)],
);

/**
 * Projects (jobs) are a core dimension supporting job costing, WIP, and
 * Account × Project reporting without bolt-on custom fields.
 */
export const projects = pgTable(
  "projects",
  {
    ...dimensionColumns,
    customerId: uuid("customer_id"), // → parties
    /** ISO 3166-2 subdivision where employees perform project-site work. */
    siteJurisdiction: text("site_jurisdiction"),
    foremanId: uuid("foreman_id"), // → parties (employee role)
    managerId: uuid("manager_id"),
    status: text("status", {
      enum: ["quoted", "awarded", "active", "substantially_complete", "closed", "cancelled"],
    })
      .notNull()
      .default("active"),
    // The configurable project type is the single source of truth for a project's
    // classification (carries the profitability/invoicing/backup profiles). Any
    // coarse "billing method" is derived from the type (project_types.billing_method),
    // defaulting to time_and_materials for an unconfigured project.
    projectTypeId: uuid("project_type_id"), // → project_types
    /** Invoicing rules for THIS job, layered over the customer's and the type's. */
    invoicingProfile: jsonb("invoicing_profile"),
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
  (t) => [
    uniqueIndex("projects_org_id_id_unique").on(t.orgId, t.id),
    index("projects_customer").on(t.customerId),
    uniqueIndex("projects_org_source_identity")
      .on(
        t.orgId,
        sql`(${t.custom}->'source'->>'system')`,
        sql`(${t.custom}->'source'->>'externalId')`,
      )
      .where(sql`
        ${t.custom}->'source'->>'system' is not null
        and ${t.custom}->'source'->>'externalId' is not null
      `),
  ],
);

/**
 * Corporate cards use a subledger instead of one GL account per card.
 * All cards post to one liability account; per-card
 * detail lives on journal lines via `payment_card_id`.
 */
export const paymentCards = pgTable(
  "payment_cards",
  {
    id: id(),
    orgId: orgRef(),
    holderPartyId: uuid("holder_party_id").notNull(),
    liabilityAccountId: uuid("liability_account_id").notNull(),
    label: text("label").notNull(), // "Visa …4821 — K. Laroche"
    lastFour: text("last_four"),
    network: text("network"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [uniqueIndex("payment_cards_org_id_id_unique").on(t.orgId, t.id)],
);
