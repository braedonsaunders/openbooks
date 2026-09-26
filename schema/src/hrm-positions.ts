import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex
} from "drizzle-orm/pg-core";
import { orgs } from "./core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * HRM positions and the headcount plan (migration 0192).
 *
 * The funded establishment (positions) is separated from the people who hold
 * it (0184 employments/assignments): positions carry title, placement,
 * planned FTE and lifecycle status as bitemporal versions in the exact 0184
 * shape; position_funding carries one plan row per (position, fiscal period);
 * position_changes is the immutable evidence ledger in the
 * employment_changes style. employment_assignment_versions.position_id links
 * a held slot to its establishment without inheriting anything.
 *
 * Overlap exclusion and closure/evidence guards that need storage-level
 * concurrency safety live in the SQL migration (Drizzle has no exclusion
 * primitive).
 */

/** Stable position identity: one funded establishment slot per org code. */
export const positions = pgTable(
  "positions",
  {
    id: id(),
    orgId: orgRef(),
    positionCode: text("position_code").notNull(),
    /**
     * Aggregate optimistic-concurrency revision: bumped by exactly one on
     * ANY change under this position (revise, funding write, close).
     */
    revision: integer("revision").notNull().default(1),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "positions_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }).onDelete("cascade"),
    uniqueIndex("positions_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("positions_org_code_unique").on(t.orgId, t.positionCode),
    index("positions_org").on(t.orgId),
    check("positions_revision", sql`${t.revision} >= 1`),
    check("positions_code_not_blank", sql`char_length(btrim(${t.positionCode})) > 0`),
  ],
);

export const POSITION_STATUSES = ["planned", "open", "filled", "frozen", "closed"] as const;
