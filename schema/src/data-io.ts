import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { id, orgRef } from "./helpers";

/**
 * Import jobs — the history behind the generic bulk importer (web/lib/data-io).
 * One row per committed import run: which resource, which format, the saved
 * column mapping, the row counts, and any per-row errors (for the downloadable
 * error report). Dry-run previews are NOT persisted — only commits land here.
 * FKs (org_id, created_by) are added by referential-integrity.sql.
 */
export const importJobs = pgTable("import_jobs", {
  id: id(),
  orgId: orgRef(),
  /** DataResource key, e.g. 'tax-codes', 'accounts', 'record:project'. */
  resourceKey: text("resource_key").notNull(),
  resourceLabel: text("resource_label"),
  /** csv | xlsx | json. */
  format: text("format").notNull(),
  fileName: text("file_name"),
  /** insert | upsert. */
  mode: text("mode").notNull().default("upsert"),
  status: text("status", { enum: ["committed", "failed"] }).notNull().default("committed"),
  /** Source-column → field-key mapping used for this run. */
  mapping: jsonb("mapping").$type<Record<string, string>>().notNull().default({}),
  totalRows: integer("total_rows").notNull().default(0),
  createdCount: integer("created_count").notNull().default(0),
  updatedCount: integer("updated_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  /** [{ row, message, field? }] — powers the error report download. */
  errors: jsonb("errors").$type<{ row: number; message: string; field?: string }[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by"),
});
