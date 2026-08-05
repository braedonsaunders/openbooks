import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { id, orgRef } from "./helpers";

/**
 * Durable exactly-once boundary for externally retried application commands.
 * The row is inserted, the command runs, and the response is stored in one
 * tenant-scoped transaction. A failed command rolls the row back, so a safe
 * retry can execute; a completed retry returns the original response.
 */
export const applicationIdempotencyKeys = pgTable(
  "application_idempotency_keys",
  {
    id: id(),
    orgId: orgRef(),
    actorId: uuid("actor_id").notNull(),
    source: text("source", { enum: ["api", "mcp", "assistant"] }).notNull(),
    operation: text("operation").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    response: jsonb("response").$type<unknown>(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '30 days'`),
  },
  (table) => [
    uniqueIndex("application_idempotency_identity").on(
      table.orgId,
      table.actorId,
      table.source,
      table.operation,
      table.idempotencyKey,
    ),
    index("application_idempotency_expiry").on(table.expiresAt),
  ],
);
