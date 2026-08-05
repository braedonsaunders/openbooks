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
 * Environments (sandboxes). A sandbox is just another `orgs` row
 * (env_kind='sandbox'), created in seconds by the deterministic UUID-rebase
 * clone engine, refreshed non-destructively (business data re-pulled while the
 * sandbox's customization layer is preserved), and isolated by Postgres RLS. PII
 * can be masked on copy, and changes tested in a sandbox promote back to
 * production as reviewable change sets.
 *
 * One `sandboxes` row per environment. `orgId` is the sandbox org (the clone);
 * `productionOrgId` is the source it was cloned from.
 */
export const sandboxes = pgTable(
  "sandboxes",
  {
    id: id(),
    /** The sandbox org row this environment IS (env_kind='sandbox'). */
    orgId: orgRef(),
    /** The production org this sandbox was cloned from. */
    productionOrgId: uuid("production_org_id").notNull(),
    name: text("name").notNull(),
    /**
     * Tier:
     *   dev    — customization layer only, no business data. Instant.
     *   masked — full copy with PII masked on refresh. The recommended default.
     *   full   — full unmasked copy (admin-gated, real numbers for UAT).
     *   as_of  — time-travel branch: ledger cloned up to a period close.
     */
    tier: text("tier", { enum: ["dev", "masked", "full", "as_of"] })
      .notNull()
      .default("masked"),
    masked: boolean("masked").notNull().default(true),
    /** For tier='as_of': clone the ledger only through this period's close. */
    asOfPeriodId: uuid("as_of_period_id"),
    status: text("status", {
      enum: ["provisioning", "ready", "refreshing", "failed", "deleting"],
    })
      .notNull()
      .default("provisioning"),
    /** Last error message when status='failed'. */
    lastError: text("last_error"),
    lastRefreshAt: timestamp("last_refresh_at", { withTimezone: true }),
    /** Optional cron for scheduled refresh (null = manual only). */
    refreshSchedule: text("refresh_schedule"),
    /** Preserve the sandbox customization layer across scheduled refreshes. */
    refreshKeepCustomizations: boolean("refresh_keep_customizations")
      .notNull()
      .default(true),
    /** Storage accounting captured at last refresh. */
    storageRows: integer("storage_rows").notNull().default(0),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("sandboxes_org").on(t.orgId),
    index("sandboxes_production").on(t.productionOrgId),
  ],
);

/**
 * Masking policy — the column-level transform registry applied inline during
 * the clone copy for masked/full-with-masking sandboxes. Scoped to the
 * production org so each tenant tunes what gets scrambled. `transform` selects
 * the rewrite; `config` carries transform parameters (e.g. jitter percentage).
 */
export const maskingPolicies = pgTable(
  "masking_policies",
  {
    id: id(),
    orgId: orgRef(),
    tableName: text("table_name").notNull(),
    columnName: text("column_name").notNull(),
    transform: text("transform", {
      enum: [
        "faker_name",
        "faker_email",
        "faker_phone",
        "redact",
        "hash",
        "jitter_amount",
        "null_out",
        "reseal_secret",
      ],
    }).notNull(),
    config: jsonb("config").notNull().default({}),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [uniqueIndex("masking_policies_col").on(t.orgId, t.tableName, t.columnName)],
);

/**
 * Change set — a promotion artifact. Config flows UP (sandbox → production);
 * business/ledger data never does. A change set is a captured diff of the
 * sandbox's customization layer (scripts, custom fields, forms, roles, reports…)
 * against production, reviewed, then applied to production in one transaction.
 * This is openbooks' native, versioned config-promotion artifact.
 */
export const changeSets = pgTable(
  "change_sets",
  {
    id: id(),
    orgId: orgRef(), // the production org the change set targets
    sandboxOrgId: uuid("sandbox_org_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status", { enum: ["draft", "applied", "discarded"] })
      .notNull()
      .default("draft"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [index("change_sets_org").on(t.orgId)],
);

/**
 * One row per changed customization record in a change set: which table, which
 * row (by production-space id), the operation, and the sandbox-side payload.
 */
export const changeSetItems = pgTable(
  "change_set_items",
  {
    id: id(),
    orgId: orgRef(),
    changeSetId: uuid("change_set_id").notNull(),
    tableName: text("table_name").notNull(),
    /** Production-space row id (the sandbox id un-rebased back to production). */
    targetId: uuid("target_id").notNull(),
    op: text("op", { enum: ["insert", "update", "delete"] }).notNull(),
    /** Sandbox row payload to apply (null for delete). */
    payload: jsonb("payload"),
    ...auditColumns,
  },
  (t) => [index("change_set_items_set").on(t.changeSetId)],
);
