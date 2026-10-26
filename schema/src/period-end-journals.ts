import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
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
import type { PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { accounts } from "./coa";
import { accountingPeriods } from "./core";
import { auditColumns, id, money, orgRef } from "./helpers";
import { journalEntries } from "./ledger";
import { subsidiaries } from "./subsidiaries";

/**
 * Effective-dated period-end journal policy (migration 0684). The row with
 * the latest effective date on or before a fiscal year end governs that
 * year's journals; versions are append-only.
 */
export const periodEndJournalPolicies = pgTable(
  "period_end_journal_policies",
  {
    id: id(),
    orgId: orgRef(),
    effectiveFrom: date("effective_from").notNull(),
    closingMethod: text("closing_method", {
      enum: ["retained_earnings", "income_summary"],
    }).notNull(),
    retainedEarningsAccountId: uuid("retained_earnings_account_id").notNull(),
    incomeSummaryAccountId: uuid("income_summary_account_id"),
    balanceSheetJournals: boolean("balance_sheet_journals").notNull().default(false),
    postingPeriod: text("posting_period", { enum: ["last_period", "adjustment_period"] })
      .notNull()
      .default("last_period"),
    preserveDepartments: boolean("preserve_departments").notNull().default(false),
    preserveClasses: boolean("preserve_classes").notNull().default(false),
    preserveLocations: boolean("preserve_locations").notNull().default(false),
    preserveProjects: boolean("preserve_projects").notNull().default(false),
    preserveSegments: boolean("preserve_segments").notNull().default(false),
    reason: text("reason").notNull(),
    ...auditColumns,
  },
  (t): PgTableExtraConfigValue[] => [
    unique("period_end_journal_policies_org_id_id_unique").on(t.orgId, t.id),
    unique("period_end_journal_policies_effective_unique").on(t.orgId, t.effectiveFrom),
    check(
      "period_end_journal_policies_income_summary",
      sql`(${t.closingMethod} = 'income_summary') = (${t.incomeSummaryAccountId} is not null)`,
    ),
    foreignKey({
      name: "period_end_journal_policies_retained_earnings_fk",
      columns: [t.orgId, t.retainedEarningsAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
    foreignKey({
      name: "period_end_journal_policies_income_summary_fk",
      columns: [t.orgId, t.incomeSummaryAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
  ],
);

/**
 * One generation of a fiscal year's period-end journals for one book and
 * legal entity. A posted generation seals the ledger through `yearEndsOn`;
 * it only ever moves to reversed.
 */
export const periodEndJournalSets = pgTable(
  "period_end_journal_sets",
  {
    id: id(),
    orgId: orgRef(),
    bookId: uuid("book_id").notNull(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    fiscalCalendarId: uuid("fiscal_calendar_id").notNull(),
    fiscalYear: integer("fiscal_year").notNull(),
    yearStartsOn: date("year_starts_on").notNull(),
    yearEndsOn: date("year_ends_on").notNull(),
    closingPeriodId: uuid("closing_period_id").notNull(),
    openingPeriodId: uuid("opening_period_id"),
    generation: integer("generation").notNull(),
    policyId: uuid("policy_id").notNull(),
    policySnapshot: jsonb("policy_snapshot").notNull(),
    contentHash: text("content_hash").notNull(),
    currency: text("currency").notNull(),
    fiscalYearEarnings: money("fiscal_year_earnings").notNull(),
    priorUnclosedEarnings: money("prior_unclosed_earnings").notNull(),
    status: text("status", { enum: ["posted", "reversed"] })
      .notNull()
      .default("posted"),
    reason: text("reason").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    generatedBy: uuid("generated_by"),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedBy: uuid("reversed_by"),
    reversalReason: text("reversal_reason"),
    reopenRequestId: uuid("reopen_request_id"),
    ...auditColumns,
  },
  (t): PgTableExtraConfigValue[] => [
    unique("period_end_journal_sets_org_id_id_unique").on(t.orgId, t.id),
    unique("period_end_journal_sets_generation_unique").on(
      t.orgId,
      t.bookId,
      t.subsidiaryId,
      t.fiscalCalendarId,
      t.fiscalYear,
      t.generation,
    ),
    uniqueIndex("period_end_journal_sets_live")
      .on(t.orgId, t.bookId, t.subsidiaryId, t.fiscalCalendarId, t.fiscalYear)
      .where(sql`status = 'posted'`),
    index("period_end_journal_sets_seal")
      .on(t.orgId, t.bookId, t.yearEndsOn)
      .where(sql`status = 'posted'`),
    index("period_end_journal_sets_history").on(t.orgId, t.fiscalYear, t.generatedAt),
    foreignKey({
      name: "period_end_journal_sets_subsidiary_fk",
      columns: [t.orgId, t.subsidiaryId],
      foreignColumns: [subsidiaries.orgId, subsidiaries.id],
    }),
    foreignKey({
      name: "period_end_journal_sets_closing_period_fk",
      columns: [t.orgId, t.closingPeriodId],
      foreignColumns: [accountingPeriods.orgId, accountingPeriods.id],
    }),
    foreignKey({
      name: "period_end_journal_sets_opening_period_fk",
      columns: [t.orgId, t.openingPeriodId],
      foreignColumns: [accountingPeriods.orgId, accountingPeriods.id],
    }),
    foreignKey({
      name: "period_end_journal_sets_policy_fk",
      columns: [t.orgId, t.policyId],
      foreignColumns: [periodEndJournalPolicies.orgId, periodEndJournalPolicies.id],
    }),
  ],
);

/** The journal entries of a generation by kind, each linked to its reversal. */
export const periodEndJournalEntries = pgTable(
  "period_end_journal_entries",
  {
    id: id(),
    orgId: orgRef(),
    setId: uuid("set_id").notNull(),
    kind: text("kind", {
      enum: ["income_statement", "income_summary", "balance_sheet", "opening"],
    }).notNull(),
    entryId: uuid("entry_id").notNull(),
    reversalEntryId: uuid("reversal_entry_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique("period_end_journal_entries_org_id_id_unique").on(t.orgId, t.id),
    unique("period_end_journal_entries_kind_unique").on(t.orgId, t.setId, t.kind),
    unique("period_end_journal_entries_entry_unique").on(t.orgId, t.entryId),
    uniqueIndex("period_end_journal_entries_reversal_unique")
      .on(t.orgId, t.reversalEntryId)
      .where(sql`reversal_entry_id is not null`),
    foreignKey({
      name: "period_end_journal_entries_set_fk",
      columns: [t.orgId, t.setId],
      foreignColumns: [periodEndJournalSets.orgId, periodEndJournalSets.id],
    }),
    foreignKey({
      name: "period_end_journal_entries_entry_fk",
      columns: [t.orgId, t.entryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
    }),
    foreignKey({
      name: "period_end_journal_entries_reversal_fk",
      columns: [t.orgId, t.reversalEntryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
    }),
  ],
);
