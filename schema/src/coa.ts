import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, currencyCode, id, orgRef } from "./helpers";

/** Monetary account types define statement placement; statistical accounts retain only quantities and units. */
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
  "statistical",
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
     * (enforced by trigger), so a parent's roll-up is always exactly the sum
     * of its children.
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
    /**
     * Surviving account this account was merged into. Set once by the
     * account merge command (which records the merge first) together with
     * when, by whom and why; a merged account is inactive, refuses every new
     * posting and reference, and stays merged permanently. Its posted
     * history keeps this account id.
     */
    mergedIntoId: uuid("merged_into_id"),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    mergedBy: uuid("merged_by"),
    mergeReason: text("merge_reason"),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("accounts_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("accounts_org_number").on(t.orgId, t.number),
    index("accounts_org_type").on(t.orgId, t.type),
    index("accounts_parent").on(t.parentId),
    check(
      "accounts_reconcilable_currency_required",
      sql`not ${t.reconcilable} or ${t.currencyRestriction} is not null`,
    ),
    check(
      "accounts_merge_state",
      sql`(${t.mergedIntoId} is null and ${t.mergedAt} is null and ${t.mergedBy} is null and ${t.mergeReason} is null)
        or (${t.mergedIntoId} is not null and ${t.mergedIntoId} <> ${t.id} and ${t.mergedAt} is not null
            and ${t.mergedBy} is not null and ${t.mergeReason} is not null
            and length(btrim(${t.mergeReason})) between 8 and 1000 and not ${t.isActive})`,
    ),
    index("accounts_merged_into").on(t.orgId, t.mergedIntoId),
  ],
);

/**
 * Append-only record of each executed account merge: the survivor, the
 * effective date the balance moved on, the reason, the digest of the
 * consequences the operator previewed, and the result (reclass journal
 * entries and redirected configuration references). One merge per source
 * account; the request key makes a retried merge return the same record.
 */
export const accountMerges = pgTable(
  "account_merges",
  {
    id: id(),
    orgId: orgRef(),
    sourceAccountId: uuid("source_account_id").notNull(),
    targetAccountId: uuid("target_account_id").notNull(),
    effectiveDate: date("effective_date").notNull(),
    reason: text("reason").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    /** The approved Accounting event proposal, when a Flow governed the merge. */
    financialChangeId: uuid("financial_change_id"),
    previewDigest: text("preview_digest").notNull(),
    result: jsonb("result").$type<Record<string, unknown>>().notNull(),
    mergedBy: uuid("merged_by").notNull(),
    mergedAt: timestamp("merged_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("account_merges_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("account_merges_idempotency").on(t.orgId, t.idempotencyKey),
    uniqueIndex("account_merges_source_once").on(t.orgId, t.sourceAccountId),
    index("account_merges_target").on(t.orgId, t.targetAccountId),
    check("account_merges_distinct", sql`${t.sourceAccountId} <> ${t.targetAccountId}`),
    foreignKey({
      name: "account_merges_source_fkey",
      columns: [t.orgId, t.sourceAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
    foreignKey({
      name: "account_merges_target_fkey",
      columns: [t.orgId, t.targetAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
  ],
);

/**
 * Accounting contexts: named presentation contexts (for example a local
 * statutory chart) under which reports show localized account numbers and
 * names. A subsidiary, or every subsidiary of a country, can default to a
 * context through accounting_context_defaults.
 */
export const accountingContexts = pgTable(
  "accounting_contexts",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("accounting_contexts_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("accounting_contexts_org_code").on(t.orgId, t.code),
  ],
);

/** The context a subsidiary (or every subsidiary of a country) reports under by default. */
export const accountingContextDefaults = pgTable(
  "accounting_context_defaults",
  {
    id: id(),
    orgId: orgRef(),
    contextId: uuid("context_id").notNull(),
    subsidiaryId: uuid("subsidiary_id"),
    /** ISO 3166-1 alpha-2. Exactly one of subsidiary or country is set. */
    country: text("country"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("accounting_context_defaults_org_id_id_unique").on(t.orgId, t.id),
    check(
      "accounting_context_defaults_one_scope",
      sql`num_nonnulls(${t.subsidiaryId}, ${t.country}) = 1`,
    ),
    foreignKey({
      name: "accounting_context_defaults_context_fkey",
      columns: [t.orgId, t.contextId],
      foreignColumns: [accountingContexts.orgId, accountingContexts.id],
    }),
  ],
);

/**
 * Localized account number and/or name per accounting context, effective
 * from a date (inclusive) through an optional end date (inclusive), and
 * optionally specific to one subsidiary (null = every subsidiary). Storage
 * refuses overlapping versions for one account and scope, and a localized
 * number used by two accounts in the same context and scope at once.
 */
export const accountLocalizations = pgTable(
  "account_localizations",
  {
    id: id(),
    orgId: orgRef(),
    contextId: uuid("context_id").notNull(),
    accountId: uuid("account_id").notNull(),
    subsidiaryId: uuid("subsidiary_id"),
    localizedNumber: text("localized_number"),
    localizedName: text("localized_name"),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("account_localizations_org_id_id_unique").on(t.orgId, t.id),
    index("account_localizations_account").on(t.orgId, t.accountId, t.contextId),
    check(
      "account_localizations_value",
      sql`${t.localizedNumber} is not null or ${t.localizedName} is not null`,
    ),
    check(
      "account_localizations_window",
      sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
    foreignKey({
      name: "account_localizations_context_fkey",
      columns: [t.orgId, t.contextId],
      foreignColumns: [accountingContexts.orgId, accountingContexts.id],
    }),
    foreignKey({
      name: "account_localizations_account_fkey",
      columns: [t.orgId, t.accountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
  ],
);
