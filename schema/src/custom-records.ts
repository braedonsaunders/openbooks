import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

export const CUSTOM_RECORD_STATUSES = ["draft", "active", "inactive"] as const;

export const customRecords = pgTable(
  "custom_records",
  {
    id: id(),
    orgId: orgRef(),
    typeId: uuid("type_id").notNull(),
    /** Denormalized type slug for cheap per-module listing (mirrors form_responses.template_key). */
    typeKey: text("type_key").notNull(),
    /** Per-type sequence via number_sequences ('custrec:'+typeKey), e.g. EQU-00001. */
    recordNumber: text("record_number").notNull(),
    /**
     * Field values keyed by field id. Formula field values are recomputed
     * server-side on every save and persisted here so lists/reports read
     * them without re-evaluating trees.
     */
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    /**
     * Space-joined lowercase haystack recomputed on every save from the
     * type's current fields: raw text/number values, choice labels, and the
     * display names behind gl_account/party refs — what the module list's
     * search ILIKEs against.
     */
    searchText: text("search_text").notNull().default(""),
    /**
     * Records are master data, not postable documents: they stay editable
     * while active. draft → active is the explicit "this row is real" step
     * (enforces required fields); inactive rows are read-only and hidden
     * from pickers until reactivated.
     */
    status: text("status", { enum: CUSTOM_RECORD_STATUSES }).notNull().default("draft"),
    /** Strictly increasing OCC counter, see documents.revisionSeq (migration 0167). */
    revisionSeq: bigint("revision_seq", { mode: "number" }).notNull().default(0),
    ...auditColumns, // includes created_by / updated_by
  },
  (t) => [
    uniqueIndex("custom_records_type_number").on(t.typeId, t.recordNumber),
    index("custom_records_org_type_status").on(t.orgId, t.typeKey, t.status),
    index("custom_records_org_type_created").on(t.orgId, t.typeKey, t.createdAt),
  ],
);

/*
FOREIGN KEYS (added by the generated migration — referential-integrity.sql):
  custom_record_types.org_id                 → orgs.id
  custom_record_types.created_by/updated_by  → users.id
  custom_records.org_id                      → orgs.id
  custom_records.type_id                     → custom_record_types.id ON DELETE RESTRICT
  custom_records.created_by/updated_by       → users.id
*/
