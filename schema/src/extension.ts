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
      enum: [
        "text",
        "long_text",
        "number",
        "currency",
        "date",
        "boolean",
        "select",
        "multi_select",
        "reference",
        "file",
      ],
    }).notNull(),
    /** For select: options; for reference: the referenced table. */
    config: jsonb("config").notNull().default({}),
    isRequired: boolean("is_required").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    index("custom_field_defs_target").on(t.orgId, t.targetTable, t.targetKind),
  ],
);

/**
 * User scripts — real JavaScript, sandboxed (QuickJS), attached to trigger
 * points. The SuiteScript idea with a modern runtime: scripts receive a
 * context (document + lines + org), can mutate whitelisted fields, veto the
 * operation with ob.abort(), and log. Execution order = sortOrder.
 *
 * Script kinds beyond the document-lifecycle triggers:
 *   endpoint — HTTP-invokable (the RESTlet idea): POST /api/scripts/e/<slug>
 *              runs main(ctx) with ctx.request; needs scripts.execute.
 *   bulk     — long-budget background job (map/reduce-lite): enqueued to the
 *              BullMQ scripts queue and run on the worker with extended
 *              timeout/row limits; falls back inline when Redis is down.
 *   client   — delivered to the browser and executed in a sandboxed
 *              opaque-origin iframe evaluator (never in the host page);
 *              used for form-level validation hooks.
 */
export const userScripts = pgTable(
  "user_scripts",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    triggerPoint: text("trigger_point", {
      enum: [
        "before_submit",
        "before_post",
        "after_post",
        "before_void",
        "scheduled",
        "endpoint",
        "bulk",
        "client",
      ],
    }).notNull(),
    /** Narrow to a document kind; null = all kinds at this trigger. */
    documentKind: text("document_kind"),
    /** endpoint scripts: URL slug (unique per org). POST /api/scripts/e/<slug>. */
    endpointSlug: text("endpoint_slug"),
    /** ES2023 JavaScript source. Entry point: export default function(ctx). */
    source: text("source").notNull(),
    /** For scheduled scripts. */
    cron: text("cron"),
    /** Scheduled scripts: next due tick (polled by engine/src/scheduler.ts);
     *  null = not scheduled. Set on create/update from the cron expression. */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    /** Denormalized last-execution stamp for the admin list view. */
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    timeoutMs: integer("timeout_ms").notNull().default(2000),
    sortOrder: integer("sort_order").notNull().default(100),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    index("user_scripts_trigger").on(
      t.orgId,
      t.triggerPoint,
      t.documentKind,
      t.isActive,
    ),
    index("user_scripts_scheduled").on(
      t.orgId,
      t.triggerPoint,
      t.isActive,
      t.nextRunAt,
    ),
    uniqueIndex("user_scripts_endpoint_slug").on(t.orgId, t.endpointSlug),
  ],
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
    status: text("status", {
      enum: ["ok", "aborted", "error", "timeout"],
    }).notNull(),
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
    role: text("role", {
      enum: ["admin", "controller", "accountant", "approver", "viewer"],
    })
      .notNull()
      .default("viewer"),
    partyId: uuid("party_id"),
    /** UI language (BCP 47, e.g. "en", "fr"). Null = inherit the org default
     *  (orgs.settings.defaultLocale). Shipped locales: web/i18n/config.ts. */
    locale: text("locale"),
    /** Navigation layout: 'sidebar' | 'topbar'. Null = org default
     *  (orgs.settings.defaultNavMode). See web/lib/nav-mode.ts. */
    navMode: text("nav_mode"),
    /**
     * The user's personal home dashboard (insight_dashboards.id). Null = fall
     * back to their role's default home, then the org's seeded system default.
     * See web/app/(app)/page.tsx `resolveHomeDashboard`. No FK column — the home
     * loader tolerates a dangling pointer (renders the fallback) so deleting a
     * dashboard can't lock a user out of their home.
     */
    homeDashboardId: uuid("home_dashboard_id"),
    /**
     * Super admin — a cross-tenant operator. Can enter any org (production or
     * sandbox) via the workspace switcher, holds all permissions everywhere, and
     * reaches the super-admin console. Distinct from the per-org `admin` role,
     * which is scoped to one org. The user's own home row carries the flag; it
     * follows the login identity, not the org.
     */
    isSuperAdmin: boolean("is_super_admin").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [uniqueIndex("users_org_email").on(t.orgId, t.email)],
);

/**
 * Statement layouts as data — custom P&L / balance-sheet row structures
 * (the job NetSuite does with 25 hand-built "financial layout" objects).
 * rows: ordered JSON, e.g.
 *   { kind: "group",    label: "Direct Labour", match: { numberPrefixes: ["51"] } }
 *   { kind: "subtotal", label: "Total Direct Costs", of: ["Direct Labour", "Materials"] }
 *   { kind: "formula",  label: "Gross Margin", plus: ["Revenue"], minus: ["Total Direct Costs"] }
 * Unmatched accounts land in an automatic "Other" group so nothing is
 * silently dropped from a statement.
 */
export const statementLayouts = pgTable(
  "statement_layouts",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    statement: text("statement", { enum: ["pnl", "balance_sheet"] }).notNull(),
    rows: jsonb("rows").notNull().default([]),
    isDefault: boolean("is_default").notNull().default(false),
    ...auditColumns,
  },
  (t) => [index("statement_layouts_org").on(t.orgId, t.statement)],
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
 * A tenant-configured link to an external accounting system (NetSuite, QBO,
 * Xero…). Created and managed by the tenant in the platform page — one org can
 * hold several (e.g. mirror from NetSuite while trialling QBO). Drives the
 * migration loader, the incremental "mirror" sync, and the A/B comparison.
 *
 * Credentials NEVER live in plaintext: `secrets` holds an AES-256-GCM sealed
 * JSON blob (engine/src/secrets.ts, keyed on OPENBOOKS_DATA_KEY); `config`
 * holds only non-secret settings (host, account id, base currency, realm id).
 */
export const connections = pgTable(
  "connections",
  {
    id: id(),
    orgId: orgRef(),
    /** Source type key: "netsuite" | "qbo" | … (matches the adapter registry). */
    source: text("source").notNull(),
    displayName: text("display_name").notNull(),
    /** How this connection authenticates: token paste vs OAuth redirect. */
    authKind: text("auth_kind", { enum: ["token", "oauth2"] })
      .notNull()
      .default("token"),
    status: text("status", {
      enum: ["active", "paused", "error", "unconfigured"],
    })
      .notNull()
      .default("unconfigured"),
    /** Non-secret settings (host, account, baseCurrency, realmId, refKey…). */
    config: jsonb("config").notNull().default({}),
    /** Sealed JSON credential blob (enc:v1:… wire format). Never returned to clients. */
    secrets: text("secrets"),
    /** Mirror mode: keep this connection synced on a schedule. */
    mirrorEnabled: boolean("mirror_enabled").notNull().default(false),
    /** Cron-ish cadence label, e.g. "daily" (resolved by the scheduler). */
    mirrorSchedule: text("mirror_schedule").notNull().default("daily"),
    /** Source-clock high-water mark of the last successful sync. */
    cursor: timestamp("cursor", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastError: text("last_error"),
    ...auditColumns,
  },
  (t) => [
    index("connections_org").on(t.orgId),
    uniqueIndex("connections_org_name").on(t.orgId, t.displayName),
  ],
);

/**
 * External-system sync/migration runs — one row per full migration or
 * incremental "mirror" pass, scoped to the `connections` row that produced it.
 */
export const syncRuns = pgTable(
  "sync_runs",
  {
    id: id(),
    orgId: orgRef(),
    /** The connection this run belongs to (nullable: pre-connections legacy runs). */
    connectionId: uuid("connection_id"),
    source: text("source").notNull(), // "netsuite"
    kind: text("kind", {
      enum: [
        "incremental",
        "full_migration",
        "full_preflight",
        "project_financials",
        "targeted_repair",
        "attachments",
        "tb_check",
      ],
    })
      .notNull()
      .default("incremental"),
    status: text("status", { enum: ["running", "ok", "failed"] })
      .notNull()
      .default("running"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** High-water mark this run synced up to (source clock). */
    syncedThrough: timestamp("synced_through", { withTimezone: true }),
    /** { newEntries, reversedEntries, linesInserted, tbAccounts, tbMismatches, ... } */
    stats: jsonb("stats").notNull().default({}),
    /** Live progress while status='running': { phase, message, current, total,
     *  docsNew, docsAmended, docsUnchanged, docsFailed }. The platform page
     *  polls this to show "pulling X of Y transactions", "posting X of Y", etc. */
    progress: jsonb("progress").notNull().default({}),
    errorMessage: text("error_message"),
    triggeredBy: text("triggered_by"), // "ui", "cli", "worker", "scheduler"
  },
  (t) => [
    index("sync_runs_org_started").on(t.orgId, t.startedAt),
    index("sync_runs_connection").on(t.connectionId, t.startedAt),
  ],
);

/** Controller evidence for a source transaction that disappeared upstream. */
export const sourceDeletionResolutions = pgTable(
  "source_deletion_resolutions",
  {
    id: id(),
    orgId: orgRef(),
    connectionId: uuid("connection_id").notNull(),
    sourceRef: text("source_ref").notNull(),
    documentId: uuid("document_id"),
    action: text("action", { enum: ["retain", "void"] }).notNull(),
    note: text("note"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedBy: uuid("resolved_by"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("source_deletion_resolutions_connection_ref").on(
      t.connectionId,
      t.sourceRef,
    ),
    index("source_deletion_resolutions_org").on(t.orgId, t.resolvedAt),
  ],
);

/**
 * Immutable audit trail for business-layer changes and open-period posted
 * transaction amendments. Posted transactions may be re-materialized in an
 * open period, so their document + GL before/after snapshots live here.
 * Written inside the same transaction as the mutation; UPDATE/DELETE is
 * blocked by the kernel.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    orgId: orgRef(),
    tableName: text("table_name").notNull(),
    rowId: uuid("row_id").notNull(),
    action: text("action", {
      enum: ["insert", "update", "delete", "post", "void", "approve", "reject"],
    }).notNull(),
    /** Field diffs or a full posted-transaction before/after evidence envelope. */
    changes: jsonb("changes").notNull().default({}),
    actorId: uuid("actor_id"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    requestId: text("request_id"),
  },
  (t) => [
    index("audit_log_row").on(t.tableName, t.rowId),
    index("audit_log_org_at").on(t.orgId, t.at),
  ],
);
