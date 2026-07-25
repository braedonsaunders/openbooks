import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, currencyCode, fxRate, id, money, orgRef } from "./helpers";

/**
 * THE KERNEL. Controlled-mutation double-entry journal.
 *
 * Invariants enforced in Postgres (see migrations/kernel-constraints.sql):
 *  - SUM(journal_lines.amount) = 0 per entry (deferred constraint trigger)
 *  - posted entries are locked by default; audited engine amendments are
 *    allowed only while both the old and new accounting scopes are open
 *  - lines post only to active, non-summary accounts
 *  - entry period must be open for the entry's module at post time
 *  - amount = round(txn_amount * fx_rate) when currency differs from base
 */
export const journalEntries = pgTable(
  "journal_entries",
  {
    id: id(),
    orgId: orgRef(),
    /** Every entry belongs to exactly one accounting book (→ accounting_books). */
    bookId: uuid("book_id").notNull(),
    /**
     * Originating subsidiary. Lines carry their own subsidiary_id — an
     * intercompany entry spans several — and the kernel enforces that each
     * subsidiary's lines sum to zero independently (every legal entity's
     * books balance on their own).
     */
    subsidiaryId: uuid("subsidiary_id").notNull(),
    entryNumber: text("entry_number").notNull(),
    postingDate: date("posting_date").notNull(),
    periodId: uuid("period_id").notNull(),
    memo: text("memo"),
    status: text("status", { enum: ["draft", "posted", "reversed"] })
      .notNull()
      .default("draft"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    postedBy: uuid("posted_by"),
    /**
     * Where this entry came from. Documents post through the kernel, so an
     * entry is traceable to its source; manual journals say so explicitly.
     * `origin` supports the payroll/burden tagging that reference organization implemented
     * as custbody checkboxes ("Payroll Journal", "Is Labor Burden JE").
     */
    sourceDocumentId: uuid("source_document_id"),
    origin: text("origin", {
      enum: [
        "document",
        "manual",
        "payroll",
        "labor_burden",
        "depreciation",
        "disposal",
        "revaluation",
        "revenue_recognition",
        "inventory",
        "allocation",
        "intercompany",
        "fx_settlement",
        "translation",
        "closing",
        "migration",
        "tax_provision",
      ],
    })
      .notNull()
      .default("manual"),
    /** Reversal chain for voids and closed-period corrections. */
    reversesEntryId: uuid("reverses_entry_id"),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    index("je_org_date").on(t.orgId, t.postingDate),
    index("je_org_period").on(t.orgId, t.periodId),
    index("je_source_doc").on(t.sourceDocumentId),
  ],
);

export const journalLines = pgTable(
  "journal_lines",
  {
    id: id(),
    orgId: orgRef(),
    entryId: uuid("entry_id").notNull(),
    lineNumber: integer("line_number").notNull(),
    accountId: uuid("account_id").notNull(),
    /** The legal entity this line posts to (→ subsidiaries). */
    subsidiaryId: uuid("subsidiary_id").notNull(),
    /**
     * Signed amount in the LINE's subsidiary's functional currency:
     * positive = debit, negative = credit. Consolidation translates.
     */
    amount: money("amount").notNull(),
    /** Transaction-currency detail; equal to amount when txn currency = base. */
    currency: currencyCode("currency").notNull(),
    txnAmount: money("txn_amount").notNull(),
    fxRate: fxRate("fx_rate").notNull().default("1"),
    memo: text("memo"),

    // -- Dimensions: one uniform mechanism -------------------------------
    partyId: uuid("party_id"), // subledger party (AR/AP lines require it)
    departmentId: uuid("department_id"),
    projectId: uuid("project_id"),
    locationId: uuid("location_id"),
    classId: uuid("class_id"),
    equipmentUnitId: uuid("equipment_unit_id"),
    paymentCardId: uuid("payment_card_id"), // card subledger detail
    extraDims: jsonb("extra_dims").notNull().default({}), // registry-validated

    /** Statistical quantity (hours, tonnes) — replaces source platform Stat accounts. */
    quantity: money("quantity"),
    unit: text("unit"),

    /** Open-item tracking for receivable/payable lines. */
    dueDate: date("due_date"),
    isOpenItem: boolean("is_open_item").notNull().default(false),

    /** Tax linkage: which tax code produced this line (for tax lines). */
    taxCodeId: uuid("tax_code_id"),

    /** Bank/card reconciliation state for reconcilable accounts. */
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    reconciliationId: uuid("reconciliation_id"),

    custom: jsonb("custom").notNull().default({}),
  },
  (t) => [
    index("jl_entry").on(t.entryId),
    index("jl_org_account").on(t.orgId, t.accountId),
    index("jl_org_sub_account").on(t.orgId, t.subsidiaryId, t.accountId),
    index("jl_org_project").on(t.orgId, t.projectId),
    index("jl_org_party_open").on(t.orgId, t.partyId, t.isOpenItem),
    check("jl_nonzero", sql`${t.amount} <> 0`),
  ],
);

/**
 * Payment application — universal. Links a crediting line to a debiting
 * open item regardless of document type: payment→invoice, journal→invoice
 * (reference organization's actual AR pattern: 18.5k of these, zero payment records),
 * credit-memo→invoice, vendor-credit→bill, prepayment→bill.
 */
export const applications = pgTable(
  "applications",
  {
    id: id(),
    orgId: orgRef(),
    fromLineId: uuid("from_line_id").notNull(), // the crediting side
    toLineId: uuid("to_line_id").notNull(), // the open item being settled
    amount: money("amount").notNull(), // always positive, in base currency
    /** Source-line carrying amount; differs from amount on realized FX settlement. */
    sourceAmount: money("source_amount").notNull(),
    /** Amount consumed from the payment/credit source in its transaction currency. */
    sourceTransactionAmount: money("source_transaction_amount").notNull(),
    sourceTransactionCurrency: currencyCode("source_transaction_currency").notNull(),
    /** Amount extinguished on the invoice/bill target in its transaction currency. */
    targetTransactionAmount: money("target_transaction_amount").notNull(),
    targetTransactionCurrency: currencyCode("target_transaction_currency").notNull(),
    /** Target-currency units per one source-currency unit, retained as settlement evidence. */
    settlementRate: fxRate("settlement_rate").notNull(),
    settlementRateSource: text("settlement_rate_source", {
      enum: ["same_currency", "provider", "manual", "contractual", "imported"],
    }).notNull(),
    /** Provider quote, bank advice, contract, or source-system reference. */
    settlementRateReference: text("settlement_rate_reference").notNull(),
    /** Optional tenant-owned spot-rate observation supporting the settlement rate. */
    settlementFxRateId: uuid("settlement_fx_rate_id"),
    appliedOn: date("applied_on").notNull(),
    /** FX difference on settlement posts its own journal entry. */
    fxGainLossEntryId: uuid("fx_gain_loss_entry_id"),
    unappliedAt: timestamp("unapplied_at", { withTimezone: true }), // soft-reversal
    ...auditColumns,
  },
  (t) => [
    index("app_from").on(t.fromLineId),
    index("app_to").on(t.toLineId),
    check("app_positive", sql`${t.amount} > 0`),
    check("app_source_positive", sql`${t.sourceAmount} > 0`),
    check("app_source_transaction_positive", sql`${t.sourceTransactionAmount} > 0`),
    check("app_target_transaction_positive", sql`${t.targetTransactionAmount} > 0`),
    check("app_settlement_rate_positive", sql`${t.settlementRate} > 0`),
    check("app_rate_reference_required", sql`length(btrim(${t.settlementRateReference})) > 0`),
  ],
);
