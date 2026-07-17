import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, currencyCode, fxRate, id, orgRef } from "./helpers";

/**
 * Subsidiaries — legal entities INSIDE a tenant (NetSuite OneWorld model).
 *
 * The org stays the sealed tenant boundary (RLS, sandboxes, login realm);
 * a subsidiary is a first-class FIELD inside it: every transaction belongs to
 * exactly one, entities are subsidiary-scoped with sharing, accounts and
 * dimensions carry optional subsidiary restrictions, roles restrict visibility,
 * and reports take a subsidiary context (a parent consolidates its subtree).
 *
 * Every org has exactly one ROOT subsidiary (parent_id null, enforced by a
 * partial unique index); single-subsidiary orgs never see any of this UI.
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
    /** Holds only elimination entries; visible only in consolidated views. */
    isElimination: boolean("is_elimination").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
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
 * (`parties.subsidiary_id`) — NetSuite's Multi-Subsidiary Customer/Vendor.
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
 * three translation rates (NetSuite's Consolidated Exchange Rates table):
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

/**
 * A role's subsidiary visibility: everything, a subtree, or an explicit list.
 * Enforced as a query filter (web/lib/subsidiaries.ts allowedSubsidiaryIds) —
 * visibility policy inside the tenant, NOT a tenancy wall.
 */
export type SubsidiaryRestriction =
  | { mode: "all" }
  | { mode: "subtree"; subsidiaryId: string }
  | { mode: "list"; subsidiaryIds: string[] };
