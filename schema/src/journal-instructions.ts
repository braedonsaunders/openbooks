import { documents } from "./documents";
import { journalEntries } from "./ledger";
import { sql } from "drizzle-orm";
import { date, foreignKey, index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/** Approved reversal instructions retain source and date while execution advances under a row lock. */
export const journalReversalInstructions = pgTable(
  "journal_reversal_instructions",
  {
    id: id(),
    orgId: orgRef(),
    documentId: uuid("document_id").notNull(),
    sourceEntryId: uuid("source_entry_id").notNull(),
    reverseOn: date("reverse_on").notNull(),
    status: text("status", { enum: ["planned", "completed", "cancelled", "blocked"] })
      .notNull()
      .default("planned"),
    reversalEntryId: uuid("reversal_entry_id"),
    lastError: text("last_error"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      columns: [t.orgId, t.documentId],
      foreignColumns: [documents.orgId, documents.id],
    }),
    foreignKey({
      columns: [t.orgId, t.sourceEntryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
    }),
    foreignKey({
      columns: [t.orgId, t.reversalEntryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
    }),
    uniqueIndex("journal_reversal_instructions_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("journal_reversal_instructions_source").on(t.orgId, t.sourceEntryId),
    index("journal_reversal_instructions_due")
      .on(t.orgId, t.reverseOn)
      .where(sql`${t.status} in ('planned','blocked')`),
  ],
);
