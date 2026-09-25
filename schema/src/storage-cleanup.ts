import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { id, orgRef } from "./helpers";

export const STORAGE_CLEANUP_OWNER_KINDS = [
  "file_version",
  "file_version_copy",
  "email_attachment",
] as const;

export type StorageCleanupOwnerKind = (typeof STORAGE_CLEANUP_OWNER_KINDS)[number];

/**
 * Durable retry ledger for S3 objects whose owner committed a deletion or
 * staged a recoverable write. Delete paths enqueue the object key in the
 * same transaction as the row delete; a worker duty drains due rows with
 * claim-expiry reclaim (see engine/src/platform/storage-cleanup.ts).
 */
export const storageCleanupOutbox = pgTable(
  "storage_cleanup_outbox",
  {
    id: id(),
    orgId: orgRef(),
    objectKey: text("object_key").notNull(),
    ownerKind: text("owner_kind", { enum: STORAGE_CLEANUP_OWNER_KINDS }).notNull(),
    ownerId: text("owner_id").notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("storage_cleanup_outbox_object_key").on(t.objectKey),
    index("storage_cleanup_outbox_due").on(t.nextAttemptAt, t.claimedAt),
    index("storage_cleanup_outbox_owner").on(t.ownerKind, t.ownerId),
    index("storage_cleanup_outbox_org").on(t.orgId, t.createdAt),
    check("storage_cleanup_outbox_owner_kind", sql`${t.ownerKind} in ('file_version','file_version_copy','email_attachment')`),
    check("storage_cleanup_outbox_nonnegative_attempts", sql`${t.attempts} >= 0`),
  ],
);
