import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * Custom-field registry: definitions here, values in each table's `custom`
 * JSONB, validated at the API layer against the definition (type, options,
 * applicability). Same philosophy as beaconhs' form/plugin framework —
 * extension without migration, but never schemaless chaos: a value without
 * a definition is rejected.
 */
export const customFieldDefs = pgTable(
  "custom_field_defs",
  {
    id: id(),
    orgId: orgRef(),
    /** Table it extends: "documents", "parties", "projects", "journal_lines"… */
    targetTable: text("target_table").notNull(),
    /** Optional narrowing, e.g. documents of kind "vendor_bill". */
    targetKind: text("target_kind"),
    key: text("key").notNull(), // snake_case, unique per target
    label: text("label").notNull(),
    fieldType: text("field_type", {
      enum: ["text", "long_text", "number", "currency", "date", "boolean", "select", "multi_select", "reference", "file"],
    }).notNull(),
    /** For select: options; for reference: the referenced table. */
    config: jsonb("config").notNull().default({}),
    isRequired: boolean("is_required").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [index("custom_field_defs_target").on(t.orgId, t.targetTable, t.targetKind)],
);

/**
 * Field-level audit trail for the business layer (the ledger needs none —
 * it's append-only). Written by the API layer inside the same transaction.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    orgId: orgRef(),
    tableName: text("table_name").notNull(),
    rowId: uuid("row_id").notNull(),
    action: text("action", { enum: ["insert", "update", "delete", "post", "void", "approve", "reject"] }).notNull(),
    /** { field: [old, new] } — only changed fields. */
    changes: jsonb("changes").notNull().default({}),
    actorId: uuid("actor_id"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    requestId: text("request_id"),
  },
  (t) => [index("audit_log_row").on(t.tableName, t.rowId), index("audit_log_org_at").on(t.orgId, t.at)],
);
