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
 * Immutable statistical-overhead adjustments.
 *
 * A rate engine remains the authoritative policy calculation. These rows
 * preserve explicit, period-dated exceptions such as a cutover reconciliation
 * or a controller-approved correction without mutating the rate card or
 * pretending a source-system exception was a generally applicable rule.
 * Corrections append an equal-and-opposite row linked through
 * `reverses_adjustment_id`.
 */
export const projectOverheadAdjustments = pgTable(
  "project_overhead_adjustments",
  {
    id: id(),
    orgId: orgRef(),
    projectId: uuid("project_id").notNull(),
    adjustmentDate: date("adjustment_date").notNull(),
    amount: money("amount").notNull(),
    reason: text("reason").notNull(),
    sourceSystem: text("source_system"),
    sourceRef: text("source_ref"),
    reversesAdjustmentId: uuid("reverses_adjustment_id"),
    evidence: jsonb("evidence").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    check("project_overhead_adjustments_nonzero", sql`${t.amount} <> 0`),
    check(
      "project_overhead_adjustments_reason",
      sql`length(btrim(${t.reason})) >= 8`,
    ),
    check(
      "project_overhead_adjustments_not_self_reversing",
      sql`${t.reversesAdjustmentId} is null or ${t.reversesAdjustmentId} <> ${t.id}`,
    ),
    uniqueIndex("project_overhead_adjustments_source_identity").on(
      t.orgId,
      t.sourceSystem,
      t.sourceRef,
    ),
    index("project_overhead_adjustments_project_date").on(
      t.orgId,
      t.projectId,
      t.adjustmentDate,
    ),
  ],
);
