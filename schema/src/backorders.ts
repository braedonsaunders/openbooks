import { sql } from "drizzle-orm";
import { check, foreignKey, index, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { id, orgRef } from "./helpers";
import { documentLines, documents } from "./documents";

/**
 * Evidence for each cancelled order-line remainder (migration 0422). Rows are
 * append-only: a trigger refuses update and delete. The line's
 * `quantity_cancelled` is the sum of its rows, written in the same
 * transaction by the cancellation service.
 */
export const orderLineCancellations = pgTable(
  "order_line_cancellations",
  {
    id: id(),
    orgId: orgRef(),
    documentId: uuid("document_id").notNull(),
    lineId: uuid("line_id").notNull(),
    quantity: numeric("quantity", { precision: 28, scale: 8 }).notNull(),
    reason: text("reason").notNull(),
    actorId: uuid("actor_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("order_line_cancellations_org_document").on(t.orgId, t.documentId, t.lineId),
    check("order_line_cancellations_quantity_check", sql`${t.quantity} > 0`),
    check("order_line_cancellations_reason_check", sql`btrim(${t.reason}) <> ''`),
    foreignKey({
      columns: [t.orgId, t.documentId],
      foreignColumns: [documents.orgId, documents.id],
      name: "order_line_cancellations_document_fkey",
    }),
    foreignKey({
      columns: [t.orgId, t.lineId],
      foreignColumns: [documentLines.orgId, documentLines.id],
      name: "order_line_cancellations_line_fkey",
    }),
  ],
);
