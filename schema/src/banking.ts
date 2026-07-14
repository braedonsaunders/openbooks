import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, currencyCode, id, money, orgRef } from "./helpers";

/**
 * Banking: statement import → matching → reconciliation sign-off, and
 * outbound payment runs (EFT/ACH/cheque batches). Statement lines are the
 * immutable imported truth; matches connect them to journal lines.
 */

export const bankStatements = pgTable(
  "bank_statements",
  {
    id: id(),
    orgId: orgRef(),
    accountId: uuid("account_id").notNull(), // → accounts (reconcilable)
    source: text("source", { enum: ["ofx", "csv", "camt053", "bai2", "feed_api", "manual"] }).notNull(),
    statementDate: date("statement_date").notNull(),
    openingBalance: money("opening_balance"),
    closingBalance: money("closing_balance"),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
    rawFileRef: text("raw_file_ref"), // file-store key of the original
    ...auditColumns,
  },
  (t) => [index("statements_account_date").on(t.accountId, t.statementDate)],
);

export const bankStatementLines = pgTable(
  "bank_statement_lines",
  {
    id: id(),
    orgId: orgRef(),
    statementId: uuid("statement_id").notNull(),
    lineNumber: integer("line_number").notNull(),
    postedOn: date("posted_on").notNull(),
    amount: money("amount").notNull(), // signed from the bank's perspective
    currency: currencyCode("currency").notNull(),
    description: text("description"),
    counterpartyRef: text("counterparty_ref"),
    bankTransactionId: text("bank_transaction_id"), // dedupe key from source
    matchStatus: text("match_status", { enum: ["unmatched", "matched", "excluded"] })
      .notNull()
      .default("unmatched"),
    ...auditColumns,
  },
  (t) => [
    index("stmt_lines_statement").on(t.statementId),
    index("stmt_lines_match_status").on(t.orgId, t.matchStatus),
  ],
);

/** A reconciliation session for one account up to a cutoff. */
export const reconciliations = pgTable(
  "reconciliations",
  {
    id: id(),
    orgId: orgRef(),
    accountId: uuid("account_id").notNull(),
    throughDate: date("through_date").notNull(),
    statementBalance: money("statement_balance").notNull(),
    status: text("status", { enum: ["in_progress", "balanced", "signed_off"] })
      .notNull()
      .default("in_progress"),
    signedOffBy: uuid("signed_off_by"),
    signedOffAt: timestamp("signed_off_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [index("recons_account").on(t.accountId)],
);

/**
 * Match units: one statement line ↔ N journal lines (or vice versa via
 * grouping id). Auto-matcher writes `matchedBy = 'auto'` with a confidence;
 * humans confirm or override.
 */
export const reconciliationMatches = pgTable(
  "reconciliation_matches",
  {
    id: id(),
    orgId: orgRef(),
    reconciliationId: uuid("reconciliation_id"),
    statementLineId: uuid("statement_line_id").notNull(),
    journalLineId: uuid("journal_line_id").notNull(),
    matchedBy: text("matched_by", { enum: ["auto", "manual", "rule"] }).notNull(),
    confidence: money("confidence"), // 0..1 for auto matches
    ...auditColumns,
  },
  (t) => [
    index("recon_matches_stmt_line").on(t.statementLineId),
    index("recon_matches_journal_line").on(t.journalLineId),
  ],
);

/** Rules that auto-categorize unmatched bank lines (create + match a doc). */
export const bankMatchRules = pgTable("bank_match_rules", {
  id: id(),
  orgId: orgRef(),
  name: text("name").notNull(),
  /** e.g. { descriptionContains: "STRIPE", amountSign: "+" } */
  criteria: jsonb("criteria").notNull().default({}),
  /** e.g. { action: "create_document", kind: "customer_payment", partyId: … } */
  outcome: jsonb("outcome").notNull().default({}),
  priority: integer("priority").notNull().default(100),
  isActive: boolean("is_active").notNull().default(true),
  ...auditColumns,
});

/**
 * Payment runs: select approved payables → generate instructions → export
 * EFT/ACH file (or print cheques) → post payments on confirmation. Mirrors
 * the (locked) Electronic Bank Payments bundle Rassaun depends on, in the
 * open.
 */
export const paymentRuns = pgTable("payment_runs", {
  id: id(),
  orgId: orgRef(),
  runNumber: text("run_number").notNull(),
  bankAccountId: uuid("bank_account_id").notNull(),
  method: text("method", { enum: ["eft", "ach", "sepa", "wire", "cheque"] }).notNull(),
  status: text("status", { enum: ["draft", "pending_approval", "approved", "exported", "confirmed", "cancelled"] })
    .notNull()
    .default("draft"),
  scheduledFor: date("scheduled_for"),
  exportedFileRef: text("exported_file_ref"),
  exportedAt: timestamp("exported_at", { withTimezone: true }),
  ...auditColumns,
});

export const paymentInstructions = pgTable(
  "payment_instructions",
  {
    id: id(),
    orgId: orgRef(),
    paymentRunId: uuid("payment_run_id").notNull(),
    payeePartyId: uuid("payee_party_id").notNull(),
    payeeBankAccountId: uuid("payee_bank_account_id"), // must be approved
    amount: money("amount").notNull(),
    currency: currencyCode("currency").notNull(),
    /** The payment document created/posted for this instruction. */
    paymentDocumentId: uuid("payment_document_id"),
    status: text("status", { enum: ["pending", "sent", "settled", "returned", "cancelled"] })
      .notNull()
      .default("pending"),
    remittanceEmailSentAt: timestamp("remittance_email_sent_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [index("pay_instructions_run").on(t.paymentRunId)],
);
