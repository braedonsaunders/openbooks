import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, currencyCode, id, orgRef } from "./helpers";

/**
 * Account types carry their normal balance and statement placement — no
 * separate lookup, no source platform 18-way stringly-typed enum leaking into
 * report logic. `Stat` (statistical/non-monetary) and `NonPosting` are
 * intentionally NOT account types here: statistical tracking uses
 * quantity fields on journal lines; non-posting documents simply don't post.
 */
export const ACCOUNT_TYPES = [
  "asset_bank",
  "asset_receivable",
  "asset_current_other",
  "asset_fixed",
  "asset_other",
  "liability_payable",
  "liability_card", // single corporate-cards control account
  "liability_current_other",
  "liability_long_term",
  "equity",
  "income",
  "income_other",
  "cogs",
  "expense",
  "expense_other",
  "expense_deferred",
] as const;

export const accounts = pgTable(
  "accounts",
  {
    id: id(),
    orgId: orgRef(),
    parentId: uuid("parent_id"),
    number: text("number"), // display code, e.g. "5100"
    name: text("name").notNull(),
    type: text("type", { enum: ACCOUNT_TYPES }).notNull(),
    description: text("description"),
    /**
     * Summary accounts group children on statements and REFUSE postings
     * (enforced by trigger). source platform lets you post to parents, silently
     * corrupting roll-ups — a top complaint found in the extraction's COA.
     */
    isSummary: boolean("is_summary").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    /** Restrict posting to a currency (bank accounts); null = any. */
    currencyRestriction: currencyCode("currency_restriction"),
    /** Marks intercompany accounts eliminated in consolidation. */
    eliminate: boolean("eliminate").notNull().default(false),
    /** Restrict posting to one subsidiary('s subtree); null = all. */
    subsidiaryId: uuid("subsidiary_id"),
    subsidiaryIncludeChildren: boolean("subsidiary_include_children").notNull().default(true),
    /** Reconcilable accounts (bank, card, clearing) get statement matching. */
    reconcilable: boolean("reconcilable").notNull().default(false),
    /**
     * IAS 21 monetary-item override for period-end FX retranslation.
     * null  → infer from type: bank, receivable, and payable accounts are
     *         monetary; everything else is not.
     * true  → retranslate this account too (foreign-currency loans and other
     *         monetary balances carried outside the default types). Ignored
     *         for income/expense/equity types — only balance-sheet items are
     *         monetary.
     * false → exclude even a default-type account (e.g. a payable-typed
     *         account used for non-monetary deferrals).
     */
    monetary: boolean("monetary"),
    /** Which dimensions are required when posting here, e.g. ["project"]. */
    requiredDimensions: jsonb("required_dimensions").$type<string[]>().notNull().default([]),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("accounts_org_number").on(t.orgId, t.number),
    index("accounts_org_type").on(t.orgId, t.type),
    index("accounts_parent").on(t.parentId),
    check(
      "accounts_reconcilable_currency_required",
      sql`not ${t.reconcilable} or ${t.currencyRestriction} is not null`,
    ),
  ],
);
