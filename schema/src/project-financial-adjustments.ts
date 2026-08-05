import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, money, orgRef } from "./helpers";

/**
 * Immutable evidence that adjusts a statistical project-financial measure
 * without rewriting native documents or the posted ledger.
 *
 * This is intentionally limited to independently reconcilable monetary inputs
 * and the final selling-price boundary. Corrections append an exact reversing
 * row; they never mutate or delete the original evidence.
 */
export const projectFinancialAdjustments = pgTable(
  "project_financial_adjustments",
  {
    id: id(),
    orgId: orgRef(),
    projectId: uuid("project_id").notNull(),
    adjustmentDate: date("adjustment_date").notNull(),
    measure: text("measure", {
      enum: [
        "actual_cost",
        "invoiced_to_date",
        "billable_value",
        "total_price",
        "could_be_invoiced",
        "gross_profit",
      ],
    }).notNull(),
    amount: money("amount").notNull(),
    reason: text("reason").notNull(),
    sourceSystem: text("source_system"),
    sourceRef: text("source_ref"),
    reversesAdjustmentId: uuid("reverses_adjustment_id"),
    evidence: jsonb("evidence").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    check("project_financial_adjustments_nonzero", sql`${t.amount} <> 0`),
    check(
      "project_financial_adjustments_measure",
      sql`${t.measure} in ('actual_cost','invoiced_to_date','billable_value','total_price','could_be_invoiced','gross_profit')`,
    ),
    check(
      "project_financial_adjustments_reason",
      sql`length(btrim(${t.reason})) >= 8`,
    ),
    check(
      "project_financial_adjustments_not_self_reversing",
      sql`${t.reversesAdjustmentId} is null or ${t.reversesAdjustmentId} <> ${t.id}`,
    ),
    check(
      "project_financial_adjustments_source_pair",
      sql`(${t.sourceSystem} is null) = (${t.sourceRef} is null)`,
    ),
    uniqueIndex("project_financial_adjustments_source_identity")
      .on(t.orgId, t.sourceSystem, t.sourceRef)
      .where(sql`${t.sourceSystem} is not null and ${t.sourceRef} is not null`),
    uniqueIndex("project_financial_adjustments_one_reversal")
      .on(t.reversesAdjustmentId)
      .where(sql`${t.reversesAdjustmentId} is not null`),
    index("project_financial_adjustments_project_date").on(
      t.orgId,
      t.projectId,
      t.adjustmentDate,
    ),
  ],
);
