import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
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
 * User scripts — real JavaScript, sandboxed (QuickJS), attached to trigger
 * points. The SuiteScript idea with a modern runtime: scripts receive a
 * context (document + lines + org), can mutate whitelisted fields, veto the
 * operation with ob.abort(), and log. Execution order = sortOrder.
 */
export const userScripts = pgTable(
  "user_scripts",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    triggerPoint: text("trigger_point", {
      enum: ["before_submit", "before_post", "after_post", "before_void", "scheduled"],
    }).notNull(),
    /** Narrow to a document kind; null = all kinds at this trigger. */
    documentKind: text("document_kind"),
    /** ES2023 JavaScript source. Entry point: export default function(ctx). */
    source: text("source").notNull(),
    /** For scheduled scripts. */
    cron: text("cron"),
    timeoutMs: integer("timeout_ms").notNull().default(2000),
    sortOrder: integer("sort_order").notNull().default(100),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [index("user_scripts_trigger").on(t.orgId, t.triggerPoint, t.documentKind, t.isActive)],
);

/** Every script run is logged — success or failure, with console output. */
export const scriptRuns = pgTable(
  "script_runs",
  {
    id: id(),
    orgId: orgRef(),
    scriptId: uuid("script_id").notNull(),
    targetKind: text("target_kind"),
    targetId: uuid("target_id"),
    status: text("status", { enum: ["ok", "aborted", "error", "timeout"] }).notNull(),
    logs: jsonb("logs").notNull().default([]),
    errorMessage: text("error_message"),
    durationMs: integer("duration_ms"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("script_runs_script").on(t.scriptId, t.at)],
);

/**
 * Application users. Password = scrypt (N=16384,r=8,p=1) stored as
 * salt:hash hex. A user may link to a party (employee) for approvals.
 */
export const users = pgTable(
  "users",
  {
    id: id(),
    orgId: orgRef(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: ["admin", "controller", "accountant", "approver", "viewer"] })
      .notNull()
      .default("viewer"),
    partyId: uuid("party_id"),
    isActive: boolean("is_active").notNull().default(true),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [uniqueIndex("users_org_email").on(t.orgId, t.email)],
);

/** Saved report views: a report path + its query params, by name. */
export const savedReports = pgTable(
  "saved_reports",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    path: text("path").notNull(), // e.g. "/reports/pnl"
    params: jsonb("params").notNull().default({}),
    createdByUserId: uuid("created_by_user_id"),
    ...auditColumns,
  },
  (t) => [index("saved_reports_org").on(t.orgId)],
);

/**
 * External-system sync/migration runs. TEMPORARY BRIDGE in its current
 * form (manual, NetSuite-only) — the MigrationSource interface it records
 * for is the seed of one-click migration from NetSuite/QuickBooks/Xero.
 */
export const syncRuns = pgTable(
  "sync_runs",
  {
    id: id(),
    orgId: orgRef(),
    source: text("source").notNull(), // "netsuite"
    kind: text("kind", { enum: ["incremental", "full_migration", "tb_check"] })
      .notNull()
      .default("incremental"),
    status: text("status", { enum: ["running", "ok", "failed"] }).notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** High-water mark this run synced up to (source clock). */
    syncedThrough: timestamp("synced_through", { withTimezone: true }),
    /** { newEntries, reversedEntries, linesInserted, tbAccounts, tbMismatches, ... } */
    stats: jsonb("stats").notNull().default({}),
    errorMessage: text("error_message"),
    triggeredBy: text("triggered_by"), // "ui", "cli"
  },
  (t) => [index("sync_runs_org_started").on(t.orgId, t.startedAt)],
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
