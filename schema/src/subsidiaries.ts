import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, currencyCode, fxRate, id, money, orgRef } from "./helpers";

/**
 * Subsidiaries are legal entities inside a tenant.
 *
 * The org stays the sealed tenant boundary (RLS, sandboxes, login realm);
 * a subsidiary is a first-class FIELD inside it: every transaction belongs to
 * exactly one, entities are subsidiary-scoped with sharing, accounts and
 * dimensions carry optional subsidiary restrictions, roles restrict visibility,
 * and reports take a subsidiary context (a parent consolidates its subtree).
 *
 * Every org has exactly one ROOT subsidiary (parent_id null, enforced by a
 * partial unique index). The storage tree guard serializes every mutation for
 * one org before it rechecks parentage, so concurrent reparents cannot create
 * a cycle from individually valid snapshots. Single-subsidiary orgs never see
 * any of this UI.
 * Elimination subsidiaries (`is_elimination`) hold only auto-elimination
 * entries and are included when — and only when — viewing consolidated.
 */
export const subsidiaries = pgTable(
  "subsidiaries",
  {
    id: id(),
    orgId: orgRef(),
    /** Consolidation tree; null = the org's single root. */
    parentId: uuid("parent_id"),
    name: text("name").notNull(),
    legalName: text("legal_name"),
    baseCurrency: currencyCode("base_currency").notNull(),
    country: text("country").notNull(), // ISO 3166-1 alpha-2
    taxIds: jsonb("tax_ids").$type<Record<string, string>>().notNull().default({}),
    /** Per-subsidiary control-account overrides; keys match
     *  orgs.settings.controlAccounts. Absent key ⇒ fall back to org default. */
    controlAccounts: jsonb("control_accounts").$type<Record<string, string>>().notNull().default({}),
    /** Holds only elimination entries; visible only in consolidated views. */
    isElimination: boolean("is_elimination").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("subsidiaries_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("subsidiaries_org_name").on(t.orgId, t.name),
    // Exactly one root per org.
    uniqueIndex("subsidiaries_org_root")
      .on(t.orgId)
      .where(sql`${t.parentId} IS NULL`),
    index("subsidiaries_org_parent").on(t.orgId, t.parentId),
  ],
);

/**
 * Additional subsidiaries an entity can transact with, beyond its primary
 * (`parties.subsidiary_id`) — source platform's Multi-Subsidiary Customer/Vendor.
 * Balances stay per (party, subsidiary) naturally: open items are journal
 * lines, and every journal line carries its subsidiary.
 */
export const partySubsidiaries = pgTable(
  "party_subsidiaries",
  {
    id: id(),
    orgId: orgRef(),
    partyId: uuid("party_id").notNull(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("party_subsidiaries_party_sub").on(t.partyId, t.subsidiaryId),
    index("party_subsidiaries_org").on(t.orgId),
  ],
);

/**
 * Consolidated exchange rates — one row per (period, currency pair) with the
 * three translation rates (source platform's Consolidated Exchange Rates table):
 *   current    → balance-sheet accounts (period-end spot)
 *   average    → P&L accounts
 *   historical → equity / historical-cost accounts
 * `source` = 'derived' when computed from daily fx_rates by the period-close
 * derivation, 'manual' when a controller overrode it. The CTA (cumulative
 * translation adjustment) that keeps translated statements balanced posts to
 * the org's designated CTA equity account.
 */
export const consolidatedFxRates = pgTable(
  "consolidated_fx_rates",
  {
    id: id(),
    orgId: orgRef(),
    periodId: uuid("period_id").notNull(),
    fromCurrency: currencyCode("from_currency").notNull(),
    toCurrency: currencyCode("to_currency").notNull(),
    currentRate: fxRate("current_rate").notNull(),
    averageRate: fxRate("average_rate").notNull(),
    historicalRate: fxRate("historical_rate").notNull(),
    source: text("source", { enum: ["derived", "manual"] }).notNull().default("derived"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("consolidated_fx_period_pair").on(t.orgId, t.periodId, t.fromCurrency, t.toCurrency),
  ],
);

/** Effective-dated direct ownership and the consolidation policy it drives. */
export const subsidiaryOwnershipInterests = pgTable(
  "subsidiary_ownership_interests",
  {
    id: id(),
    orgId: orgRef(),
    parentSubsidiaryId: uuid("parent_subsidiary_id").notNull(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    /** Inclusive ownership window. Active policies may not overlap for one
     *  consolidated subsidiary (storage constraint 0051). */
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    ownershipPercent: fxRate("ownership_percent").notNull(),
    method: text("method", { enum: ["full", "proportionate", "equity"] }).notNull().default("full"),
    acquisitionDate: date("acquisition_date").notNull(),
    acquisitionCost: money("acquisition_cost").notNull().default("0"),
    fairValueNetAssets: money("fair_value_net_assets").notNull().default("0"),
    acquisitionRate: fxRate("acquisition_rate").notNull().default("1"),
    nciMeasurement: text("nci_measurement", { enum: ["proportionate", "fair_value"] }).notNull().default("proportionate"),
    nciFairValue: money("nci_fair_value"),
    investmentAccountId: uuid("investment_account_id").notNull(),
    equityIncomeAccountId: uuid("equity_income_account_id").notNull(),
    distributionAccountId: uuid("distribution_account_id"),
    distributionIncomeAccountId: uuid("distribution_income_account_id"),
    nciEquityAccountId: uuid("nci_equity_account_id"),
    nciIncomeAccountId: uuid("nci_income_account_id"),
    goodwillAccountId: uuid("goodwill_account_id"),
    fairValueAdjustmentAccountId: uuid("fair_value_adjustment_account_id"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("subsidiary_ownership_identity").on(t.parentSubsidiaryId, t.subsidiaryId, t.effectiveFrom),
    index("subsidiary_ownership_effective").on(t.orgId, t.subsidiaryId, t.effectiveFrom, t.effectiveTo),
    check("subsidiary_ownership_distinct", sql`${t.parentSubsidiaryId} <> ${t.subsidiaryId}`),
    check("subsidiary_ownership_percent", sql`${t.ownershipPercent} > 0 and ${t.ownershipPercent} <= 100`),
    check("subsidiary_ownership_dates", sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`),
    check("subsidiary_ownership_acquisition", sql`${t.acquisitionDate} <= ${t.effectiveFrom}`),
    check("subsidiary_ownership_nci_fair_value", sql`${t.nciMeasurement} <> 'fair_value' or ${t.nciFairValue} is not null`),
  ],
);

export const ownershipConsolidationRuns = pgTable(
  "ownership_consolidation_runs",
  {
    id: id(),
    orgId: orgRef(),
    periodId: uuid("period_id").notNull(),
    status: text("status", { enum: ["running", "posted", "failed"] }).notNull().default("running"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [index("ownership_runs_period").on(t.orgId, t.periodId, t.startedAt)],
);

export const ownershipConsolidationEntries = pgTable(
  "ownership_consolidation_entries",
  {
    id: id(),
    orgId: orgRef(),
    runId: uuid("run_id").notNull(),
    interestId: uuid("interest_id").notNull(),
    kind: text("kind", { enum: ["acquisition", "nci_income", "equity_income", "reversal"] }).notNull(),
    journalEntryId: uuid("journal_entry_id").notNull(),
    ...auditColumns,
  },
  (t) => [index("ownership_entries_run_interest_kind").on(t.runId, t.interestId, t.kind)],
);

/**
 * A role's subsidiary visibility: everything, a subtree, or an explicit list.
 * Enforced as a query filter (web/lib/subsidiaries.ts allowedSubsidiaryIds) —
 * visibility policy inside the tenant, NOT a tenancy wall.
 */
export type SubsidiaryRestriction =
  | { mode: "all" }
  | { mode: "subtree"; subsidiaryId: string }
  | { mode: "list"; subsidiaryIds: string[] };
