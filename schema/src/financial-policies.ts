import { accountingBooks } from "./multibook";
import { accountingPeriods, fiscalCalendars } from "./core";
import { journalEntries } from "./ledger";
import { formLayouts } from "./customization";
import { segmentDefinitions } from "./segments";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";
import { accounts } from "./coa";
import { subsidiaries } from "./subsidiaries";

/** Named exchange-rate series, independent of the consolidation measurement method. */
export const fxRateTypes = pgTable(
  "fx_rate_types",
  {
    id: id(),
    orgId: orgRef(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("fx_rate_types_org_key").on(t.orgId, t.key),
    uniqueIndex("fx_rate_types_org_id_id_unique").on(t.orgId, t.id),
    check("fx_rate_types_key", sql`${t.key} ~ '^[a-z][a-z0-9_]{0,63}$'`),
  ],
);

/** Append-only policies preserve the translation basis of an earlier reporting date. */
export const accountTranslationPolicies = pgTable(
  "account_translation_policies",
  {
    id: id(),
    orgId: orgRef(),
    accountId: uuid("account_id").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    generalRateType: text("general_rate_type", {
      enum: ["current", "average", "historical"],
    }).notNull(),
    cashFlowRateType: text("cash_flow_rate_type", {
      enum: ["current", "average", "historical"],
    }).notNull(),
    reason: text("reason").notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("account_translation_policies_version").on(t.orgId, t.accountId, t.effectiveFrom),
    uniqueIndex("account_translation_policies_org_id_id_unique").on(t.orgId, t.id),
    foreignKey({ columns: [t.orgId, t.accountId], foreignColumns: [accounts.orgId, accounts.id] }),
    check(
      "account_translation_policies_general",
      sql`${t.generalRateType} in ('current','average','historical')`,
    ),
    check(
      "account_translation_policies_cash_flow",
      sql`${t.cashFlowRateType} in ('current','average','historical')`,
    ),
  ],
);

/** Entity-specific fiscal, posting, approval and form defaults; omitted values inherit native organization defaults. */
export const subsidiaryAccountingPreferences = pgTable(
  "subsidiary_accounting_preferences",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    fiscalCalendarId: uuid("fiscal_calendar_id"),
    postingRateType: text("posting_rate_type").notNull().default("spot"),
    requireJournalApproval: boolean("require_journal_approval").notNull().default(false),
    allowBackdatedPosting: boolean("allow_backdated_posting").notNull().default(true),
    allowFuturePosting: boolean("allow_future_posting").notNull().default(true),
    defaultJournalFormId: uuid("default_journal_form_id"),
    reason: text("reason").notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("subsidiary_accounting_preferences_version").on(
      t.orgId,
      t.subsidiaryId,
      t.effectiveFrom,
    ),
    uniqueIndex("subsidiary_accounting_preferences_org_id_id_unique").on(t.orgId, t.id),
    foreignKey({
      columns: [t.orgId, t.subsidiaryId],
      foreignColumns: [subsidiaries.orgId, subsidiaries.id],
    }),
    foreignKey({
      columns: [t.orgId, t.fiscalCalendarId],
      foreignColumns: [fiscalCalendars.orgId, fiscalCalendars.id],
    }),
    foreignKey({
      columns: [t.orgId, t.postingRateType],
      foreignColumns: [fxRateTypes.orgId, fxRateTypes.key],
    }),
    foreignKey({
      columns: [t.orgId, t.defaultJournalFormId],
      foreignColumns: [formLayouts.orgId, formLayouts.id],
    }),
  ],
);

/** Generic balancing is a posting policy, not a second financial ledger. */
export const segmentBalancingPolicies = pgTable(
  "segment_balancing_policies",
  {
    id: id(),
    orgId: orgRef(),
    segmentKey: text("segment_key").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    clearingAccountId: uuid("clearing_account_id").notNull(),
    priority: integer("priority").notNull().default(100),
    reason: text("reason").notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("segment_balancing_policies_version").on(t.orgId, t.segmentKey, t.effectiveFrom),
    uniqueIndex("segment_balancing_policies_org_id_id_unique").on(t.orgId, t.id),
    foreignKey({
      columns: [t.orgId, t.segmentKey],
      foreignColumns: [segmentDefinitions.orgId, segmentDefinitions.key],
    }),
    foreignKey({
      columns: [t.orgId, t.clearingAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
  ],
);

/** Audit numbers identify a sealed period's physical entries without changing posted journal headers. */
export const glAuditNumberPolicies = pgTable(
  "gl_audit_number_policies",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    resetRule: text("reset_rule", { enum: ["period", "fiscal_year", "never"] })
      .notNull()
      .default("period"),
    prefix: text("prefix").notNull().default("GL"),
    reason: text("reason").notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("gl_audit_number_policies_version").on(t.orgId, t.subsidiaryId, t.effectiveFrom),
    uniqueIndex("gl_audit_number_policies_org_id_id_unique").on(t.orgId, t.id),
    foreignKey({
      columns: [t.orgId, t.subsidiaryId],
      foreignColumns: [subsidiaries.orgId, subsidiaries.id],
    }),
  ],
);

export const glAuditNumberAssignments = pgTable(
  "gl_audit_number_assignments",
  {
    id: id(),
    orgId: orgRef(),
    bookId: uuid("book_id").notNull(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    periodId: uuid("period_id").notNull(),
    entryId: uuid("entry_id").notNull(),
    policyId: uuid("policy_id").notNull(),
    scopeKey: text("scope_key").notNull(),
    ordinal: integer("ordinal").notNull(),
    auditNumber: text("audit_number").notNull(),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      columns: [t.orgId, t.bookId],
      foreignColumns: [accountingBooks.orgId, accountingBooks.id],
    }),
    foreignKey({
      columns: [t.orgId, t.subsidiaryId],
      foreignColumns: [subsidiaries.orgId, subsidiaries.id],
    }),
    foreignKey({
      columns: [t.orgId, t.periodId],
      foreignColumns: [accountingPeriods.orgId, accountingPeriods.id],
    }),
    foreignKey({
      columns: [t.orgId, t.entryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
    }),
    foreignKey({
      columns: [t.orgId, t.policyId],
      foreignColumns: [glAuditNumberPolicies.orgId, glAuditNumberPolicies.id],
    }),
    uniqueIndex("gl_audit_number_assignments_entry").on(
      t.orgId,
      t.bookId,
      t.subsidiaryId,
      t.entryId,
    ),
    uniqueIndex("gl_audit_number_assignments_sequence").on(
      t.orgId,
      t.bookId,
      t.subsidiaryId,
      t.scopeKey,
      t.ordinal,
    ),
    uniqueIndex("gl_audit_number_assignments_org_id_id_unique").on(t.orgId, t.id),
    check("gl_audit_number_assignments_positive", sql`${t.ordinal} > 0`),
  ],
);

/**
 * Expense FX policy versions (0739): whether an operator may replace the
 * dated exchange rate on a foreign-currency expense line with an explicit
 * rate and reason. Append-only; no version reads as refused.
 */
export const expenseFxPolicies = pgTable(
  "expense_fx_policies",
  {
    id: id(),
    orgId: orgRef(),
    effectiveFrom: date("effective_from").notNull(),
    allowRateOverride: boolean("allow_rate_override").notNull().default(false),
    reason: text("reason").notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("expense_fx_policies_org_id_effective_from_key").on(t.orgId, t.effectiveFrom),
    uniqueIndex("expense_fx_policies_org_id_id_key").on(t.orgId, t.id),
  ],
);
