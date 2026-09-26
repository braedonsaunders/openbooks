import { index, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { auditColumns, id, money, orgRef } from "./helpers";

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
