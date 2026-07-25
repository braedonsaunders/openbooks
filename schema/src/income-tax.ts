import { boolean, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { auditColumns, id, money, orgRef } from "./helpers";

/**
 * ASC 740 / IAS 12 income-tax provision. A provision run measures current tax
 * (pretax book income ± permanent differences, at enacted rates) and deferred
 * tax (temporary differences between book and tax basis → DTA/DTL, net of
 * valuation allowance), then posts the provision journal through the kernel
 * (origin 'tax_provision'). Runs are versioned and re-postable: a repost
 * reverses the superseded entry and posts the recomputed one, so the ledger
 * always shows the current provision with a full audit trail.
 */

/** Effective-dated enacted rates; stacked jurisdictions sum (federal + state). */
export const incomeTaxRates = pgTable(
  "income_tax_rates",
  {
    id: id(),
    orgId: orgRef(),
    /** e.g. "Federal", "CA-ON", "US-TX" — stacked rows with the same scope sum. */
    jurisdiction: text("jurisdiction").notNull(),
    /** Null = org-wide (all subsidiaries). */
    subsidiaryId: uuid("subsidiary_id"),
    ratePercent: money("rate_percent").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [index("income_tax_rates_scope").on(t.orgId, t.subsidiaryId, t.isActive, t.effectiveFrom)],
);

export const TAX_DIFFERENCE_CATEGORIES = [
  "fixed_assets",
  "revenue_recognition",
  "provisions",
  "loss_carryforward",
  "other",
] as const;

/**
 * A measured temporary difference (or loss carryforward) feeding a run.
 * `difference` is signed: positive = taxable temporary difference (DTL),
 * negative = deductible (DTA). Auto rows are re-derived each computation;
 * manual rows are preparer-entered and copied into new runs of the same FY.
 */
export const temporaryDifferences = pgTable(
  "temporary_differences",
  {
    id: id(),
    orgId: orgRef(),
    runId: uuid("run_id").notNull(),
    category: text("category", { enum: TAX_DIFFERENCE_CATEGORIES }).notNull(),
    description: text("description").notNull(),
    subsidiaryId: uuid("subsidiary_id"),
    bookBasis: money("book_basis").notNull().default("0"),
    taxBasis: money("tax_basis").notNull().default("0"),
    difference: money("difference").notNull(),
    ratePercent: money("rate_percent").notNull(),
    taxEffect: money("tax_effect").notNull(),
    source: text("source", { enum: ["auto", "manual"] }).notNull().default("manual"),
    ...auditColumns,
  },
  (t) => [index("temporary_differences_run").on(t.runId), index("temporary_differences_org").on(t.orgId, t.category)],
);

export const taxProvisionRuns = pgTable(
  "tax_provision_runs",
  {
    id: id(),
    orgId: orgRef(),
    fiscalYear: integer("fiscal_year").notNull(),
    periodFrom: date("period_from").notNull(),
    periodTo: date("period_to").notNull(),
    status: text("status", { enum: ["draft", "posted", "superseded"] }).notNull().default("draft"),
    version: integer("version").notNull().default(1),
    /** tamper-evident hash of the computed payload. */
    snapshotHash: text("snapshot_hash").notNull(),
    /** Full computation: pretax income, permanent differences, current/deferred
     *  components, valuation allowance, and the rate-reconciliation steps. */
    payload: jsonb("payload").notNull(),
    journalEntryId: uuid("journal_entry_id"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    postedBy: uuid("posted_by"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("tax_provision_runs_org_fy_version").on(t.orgId, t.fiscalYear, t.version),
    index("tax_provision_runs_org").on(t.orgId, t.fiscalYear, t.status),
  ],
);
