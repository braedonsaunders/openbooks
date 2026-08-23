import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * Durable posting-effects outbox. The journal posts in one transaction;
 * obligations, inventory, and after-post automation drain after commit.
 * A crash leaves this row so a worker can call `runPostDocumentEffects`.
 */
export const POSTING_EFFECTS_STATUSES = ["pending", "running", "succeeded", "failed"] as const;

export const postingEffects = pgTable(
  "posting_effects",
  {
    id: id(),
    orgId: orgRef(),
    documentId: uuid("document_id").notNull(),
    kind: text("kind").notNull(),
    entryId: uuid("entry_id").notNull(),
    postingDate: date("posting_date").notNull(),
    actorId: uuid("actor_id"),
    status: text("status", { enum: POSTING_EFFECTS_STATUSES }).notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("posting_effects_document").on(t.documentId),
    index("posting_effects_due").on(t.status, t.nextAttemptAt),
    index("posting_effects_org").on(t.orgId, t.status, t.createdAt),
    check("posting_effects_status", sql`${t.status} in ('pending','running','succeeded','failed')`),
    check("posting_effects_nonnegative_attempts", sql`${t.attemptCount} >= 0`),
    check("posting_effects_kind", sql`length(btrim(${t.kind})) > 0`),
  ],
);
