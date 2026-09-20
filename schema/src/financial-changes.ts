import {
  date,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/** Frozen accounting proposals; Flows decides, the domain service applies. */
export const financialChanges = pgTable(
  "financial_changes",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    domain: text("domain", {
      enum: ["lease", "revenue", "asset", "consolidation"],
    }).notNull(),
    subjectId: uuid("subject_id").notNull(),
    operation: text("operation").notNull(),
    effectiveOn: date("effective_on").notNull(),
    reason: text("reason").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payload: jsonb("payload").notNull(),
    beforeState: jsonb("before_state").notNull(),
    status: text("status", {
      enum: ["draft", "pending", "approved", "rejected", "applied"],
    })
      .notNull()
      .default("draft"),
    submittedBy: uuid("submitted_by").notNull(),
    approvedBy: uuid("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    result: jsonb("result"),
    appliedBy: uuid("applied_by"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("financial_changes_request").on(t.orgId, t.idempotencyKey),
  ],
);
