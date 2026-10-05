import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { orgs } from "./core";
import { auditColumns, id, orgRef } from "./helpers";

export const BILLING_IMPORT_PROVIDERS = ["chargebee", "recurly", "maxio", "zuora"] as const;
export const BILLING_IMPORT_STATUSES = [
  "draft",
  "preflight",
  "ready",
  "running",
  "reconciling",
  "complete",
  "failed",
] as const;
export const BILLING_IMPORT_MODES = ["post_historical", "opening_balances"] as const;

/**
 * Billing-platform history import runs. One row per import execution: the
 * provider connection, the operator's mapping configuration, per-object
 * counts, the incremental cursor and the aggregate reconciliation figures.
 * Imported objects stay idempotent through `external_links`, so re-running
 * creates a new run row and never duplicates a native record. The jsonb
 * columns carry configuration, aggregate counts and aggregate reconciliation
 * figures keyed by external id only — never customer names or emails — so
 * the table holds no personal data.
 */
export const billingImportRuns = pgTable(
  "billing_import_runs",
  {
    id: id(),
    orgId: orgRef(),
    provider: text("provider", { enum: BILLING_IMPORT_PROVIDERS }).notNull(),
    externalAccount: text("external_account").notNull(),
    status: text("status", { enum: BILLING_IMPORT_STATUSES }).notNull().default("draft"),
    mode: text("mode", { enum: BILLING_IMPORT_MODES }).notNull().default("post_historical"),
    cutoverOn: date("cutover_on"),
    historyDepthMonths: integer("history_depth_months"),
    config: jsonb("config").notNull().default({}),
    counts: jsonb("counts").notNull().default({}),
    cursor: jsonb("cursor").notNull().default({}),
    reconciliation: jsonb("reconciliation"),
    lastError: text("last_error"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("billing_import_runs_org_id_id_unique").on(t.orgId, t.id),
    index("billing_import_runs_org_provider_account").on(
      t.orgId,
      t.provider,
      t.externalAccount,
      t.createdAt,
    ),
    check(
      "billing_import_runs_provider_valid",
      sql`${t.provider} in ('chargebee', 'recurly', 'maxio', 'zuora')`,
    ),
    check(
      "billing_import_runs_account_nonblank",
      sql`length(btrim(${t.externalAccount})) > 0`,
    ),
    check(
      "billing_import_runs_status_valid",
      sql`${t.status} in ('draft', 'preflight', 'ready', 'running', 'reconciling', 'complete', 'failed')`,
    ),
    check(
      "billing_import_runs_mode_valid",
      sql`${t.mode} in ('post_historical', 'opening_balances')`,
    ),
    check(
      "billing_import_runs_depth_valid",
      sql`${t.historyDepthMonths} is null or ${t.historyDepthMonths} > 0`,
    ),
    check(
      "billing_import_runs_finished_valid",
      sql`(${t.status} in ('complete', 'failed')) = (${t.finishedAt} is not null)`,
    ),
    foreignKey({ name: "billing_import_runs_org_fk", columns: [t.orgId], foreignColumns: [orgs.id] }),
  ],
);
