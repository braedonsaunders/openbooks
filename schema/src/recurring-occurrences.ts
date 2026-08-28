import { date, foreignKey, index, pgTable, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";
import { documents } from "./documents";
import { recurringSchedules } from "./time";

/**
 * Per-occurrence dedupe guard for recurring generation. One row per
 * (org, schedule, occurrence date), inserted inside the generation transaction
 * next to the cloned document it names. A tick that retries after its claim was
 * rolled back — or races a concurrent generation of the same occurrence —
 * finds the committed row and replays that document instead of posting a
 * second one. Append-only: the immutable trigger allows deletes only under a
 * sandbox wipe.
 */
export const recurringOccurrenceDocuments = pgTable(
  "recurring_occurrence_documents",
  {
    id: id(),
    orgId: orgRef(),
    scheduleId: uuid("schedule_id").notNull(),
    occurrenceOn: date("occurrence_on").notNull(),
    documentId: uuid("document_id").notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("recurring_occurrence_once").on(t.orgId, t.scheduleId, t.occurrenceOn),
    uniqueIndex("recurring_occurrence_document").on(t.documentId),
    index("recurring_occurrence_schedule").on(t.orgId, t.scheduleId, t.occurrenceOn),
    foreignKey({
      columns: [t.orgId, t.scheduleId],
      foreignColumns: [recurringSchedules.orgId, recurringSchedules.id],
      name: "recurring_occurrence_schedule_fk",
    }),
    foreignKey({
      columns: [t.orgId, t.documentId],
      foreignColumns: [documents.orgId, documents.id],
      name: "recurring_occurrence_document_fk",
    }),
  ],
);
