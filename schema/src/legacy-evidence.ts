import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { orgRef } from "./helpers";

/**
 * Verbatim evidence retained when a pre-FK tax-component row has no surviving
 * parent document line. This is not an active financial subledger.
 */
export const orphanedTaxComponentEvidence = pgTable(
  "orphaned_tax_component_evidence",
  {
    id: uuid("id").primaryKey(),
    orgId: orgRef(),
    originalDocumentLineId: uuid("original_document_line_id").notNull(),
    payload: jsonb("payload").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    archiveReason: text("archive_reason").notNull(),
    migrationFilename: text("migration_filename").notNull(),
  },
  (table) => [
    index("orphaned_tax_component_evidence_org").on(
      table.orgId,
      table.archivedAt,
    ),
  ],
);
