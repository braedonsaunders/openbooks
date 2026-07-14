import {
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { id, orgRef } from "./helpers";

/**
 * File/document attachments — attach PDFs and other files to any transaction
 * (vendor bills, invoices, payments, expenses, journals) or record.
 *
 * Two tables so lists never pull bytes:
 *   - `attachments` holds metadata only (filename, size, content type, target).
 *     Every list/index query reads exclusively from here.
 *   - `attachment_blobs` holds the raw file bytes (bytea), fetched only on the
 *     download route. Kept out of the metadata table so a list of 200
 *     attachments never streams 200 files' worth of bytes.
 *
 * Bytes live IN POSTGRES for now (self-contained; `storage_kind` defaults to
 * 'db'). Object storage is a later swap: add an 's3' storage_kind, write a
 * storage key instead of a blob row, and route downloads accordingly — no
 * change to the metadata table or its consumers.
 */

/**
 * Postgres `bytea` mapped to raw bytes. node-postgres already returns `bytea`
 * columns as a Buffer (a Uint8Array) and accepts Buffer/Uint8Array as bind
 * params, so this custom type is a straight passthrough that gives Drizzle the
 * right SQL type. Typed as `Uint8Array` (not `Buffer`) to keep the schema
 * package free of Node ambient types; Buffer is assignable at the call site.
 */
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return "bytea";
  },
});

export const attachments = pgTable(
  "attachments",
  {
    id: id(),
    orgId: orgRef(),
    /** The kind of record this file hangs off, e.g. 'documents'. */
    targetTable: text("target_table").notNull(),
    /** The specific record's id within `target_table`. */
    targetId: uuid("target_id").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    /** Where the bytes live. 'db' = attachment_blobs; future: 's3', etc. */
    storageKind: text("storage_kind").notNull().default("db"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("attachments_target").on(t.orgId, t.targetTable, t.targetId)],
);

export const attachmentBlobs = pgTable(
  "attachment_blobs",
  {
    id: id(),
    attachmentId: uuid("attachment_id").notNull(),
    bytes: bytea("bytes").notNull(),
  },
  (t) => [uniqueIndex("attachment_blobs_attachment").on(t.attachmentId)],
);

/*
 * Foreign keys (add to schema/migrations/referential-integrity.sql):
 *
 *   alter table attachments add foreign key (org_id) references orgs(id);
 *   alter table attachment_blobs
 *     add foreign key (attachment_id) references attachments(id) on delete cascade;
 */
