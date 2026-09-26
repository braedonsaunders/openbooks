import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";
import { auditColumns, currencyCode, id, orgRef } from "./helpers";

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
 * A role's subsidiary visibility: everything, a subtree, or an explicit list.
 * Enforced as a query filter (web/lib/subsidiaries.ts allowedSubsidiaryIds) —
 * visibility policy inside the tenant, NOT a tenancy wall.
 */
export type SubsidiaryRestriction =
  | { mode: "all" }
  | { mode: "subtree"; subsidiaryId: string }
  | { mode: "list"; subsidiaryIds: string[] };
