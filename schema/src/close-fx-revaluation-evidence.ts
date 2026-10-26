import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { fxRate, id, orgRef } from "./helpers";
import { accounts } from "./coa";
import { accountingPeriods, currencies } from "./core";
import { accountingBooks } from "./multibook";
import { subsidiaries } from "./subsidiaries";
import { users } from "./extension";

/**
 * An operator-recorded closing exchange rate for one exact foreign-currency
 * monetary position at period end: one account, in one legal entity, on one
 * book, for the period whose final day is the rate date. The rate converts
 * the position's transaction currency into the currency that book measures
 * the entity in, which on a secondary book can differ from the entity's
 * functional currency.
 *
 * Rows are append-only observations. The first row for a position is its
 * root; a governed correction appends a successor that supersedes it, so a
 * position's current rate is its newest version while every earlier quote
 * stays immutable for the audit snapshots that consumed it.
 */
export const fxRevaluationRateEvidence = pgTable(
  "fx_revaluation_rate_evidence",
  {
    id: id(),
    orgId: orgRef(),
    bookId: uuid("book_id").notNull(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    periodId: uuid("period_id").notNull(),
    accountId: uuid("account_id").notNull(),
    transactionCurrency: text("transaction_currency")
      .notNull()
      .references(() => currencies.code),
    /** The currency the selected book measures this entity in. */
    measurementCurrency: text("measurement_currency")
      .notNull()
      .references(() => currencies.code),
    /** Always the assigned period's final day; the guard proves it. */
    rateDate: date("rate_date").notNull(),
    rate: fxRate("rate"),
    source: text("source").notNull(),
    reason: text("reason").notNull(),
    /** 1 for a position's root observation; each successor adds one. */
    version: integer("version").notNull(),
    supersedesId: uuid("supersedes_id"),
    /** Caller-supplied replay identity, unique per organization. */
    requestId: uuid("request_id").notNull(),
    /** SHA-256 of the canonical request payload and recording actor. */
    requestSha256: text("request_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    uniqueIndex("fx_revaluation_rate_evidence_org_id_unique").on(t.orgId, t.id),
    uniqueIndex("fx_revaluation_rate_evidence_request_unique").on(t.orgId, t.requestId),
    uniqueIndex("fx_revaluation_rate_evidence_successor_unique")
      .on(t.orgId, t.supersedesId)
      .where(sql`${t.supersedesId} is not null`),
    // One root opens a position; its identity is the book, legal entity,
    // period, account and transaction currency. Measurement currency and
    // rate date are validated facts of each version, not identity.
    uniqueIndex("fx_revaluation_rate_evidence_root_unique")
      .on(t.orgId, t.bookId, t.subsidiaryId, t.periodId, t.accountId, t.transactionCurrency)
      .where(sql`${t.supersedesId} is null`),
    index("fx_revaluation_rate_evidence_position").on(
      t.orgId,
      t.bookId,
      t.subsidiaryId,
      t.periodId,
      t.accountId,
      t.transactionCurrency,
    ),
    foreignKey({
      name: "fx_revaluation_rate_evidence_book_fk",
      columns: [t.orgId, t.bookId],
      foreignColumns: [accountingBooks.orgId, accountingBooks.id],
    }),
    foreignKey({
      name: "fx_revaluation_rate_evidence_subsidiary_fk",
      columns: [t.orgId, t.subsidiaryId],
      foreignColumns: [subsidiaries.orgId, subsidiaries.id],
    }),
    foreignKey({
      name: "fx_revaluation_rate_evidence_period_fk",
      columns: [t.orgId, t.periodId],
      foreignColumns: [accountingPeriods.orgId, accountingPeriods.id],
    }),
    foreignKey({
      name: "fx_revaluation_rate_evidence_account_fk",
      columns: [t.orgId, t.accountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
    foreignKey({
      name: "fx_revaluation_rate_evidence_successor_fk",
      columns: [t.orgId, t.supersedesId],
      foreignColumns: [t.orgId, t.id],
    }),
    foreignKey({
      name: "fx_revaluation_rate_evidence_actor_fk",
      columns: [t.createdBy],
      foreignColumns: [users.id],
    }),
    check("fx_revaluation_rate_evidence_rate_positive", sql`${t.rate} > 0`),
    check(
      "fx_revaluation_rate_evidence_currencies",
      sql`${t.transactionCurrency} ~ '^[A-Z]{3}$' and ${t.measurementCurrency} ~ '^[A-Z]{3}$'
        and ${t.transactionCurrency} <> ${t.measurementCurrency}`,
    ),
    check(
      "fx_revaluation_rate_evidence_text",
      sql`char_length(${t.source}) between 1 and 120 and ${t.source} = btrim(${t.source})
        and char_length(${t.reason}) between 8 and 500 and ${t.reason} = btrim(${t.reason})
        and ${t.requestSha256} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "fx_revaluation_rate_evidence_version_shape",
      sql`(${t.version} = 1 and ${t.supersedesId} is null) or (${t.version} > 1 and ${t.supersedesId} is not null)`,
    ),
  ],
);

/** One recorded closing rate observation, as read back to operators. */
export interface CloseFxRateEvidence {
  id: string;
  bookId: string;
  subsidiaryId: string;
  periodId: string;
  accountId: string;
  transactionCurrency: string;
  measurementCurrency: string;
  rateDate: string;
  rate: string;
  source: string;
  reason: string;
  version: number;
  supersedesId: string | null;
  requestId: string;
  createdAt: string;
  createdBy: string;
}
