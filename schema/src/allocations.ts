import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accounts } from "./coa";
import { accountingBooks, accountingPeriods, classes, departments, locations, projects } from "./core";
import { subsidiaries } from "./subsidiaries";
import { documents } from "./documents";
import { timeEntries } from "./time";
import { journalEntries, journalLines } from "./ledger";
import { auditColumns, id, money, orgRef } from "./helpers";

/**
 * Allocation kernel — ONE rule model bound at three moments (see
 * docs/design/allocation-kernel.md):
 *
 *   entry  — a saved document line explodes into a group of child lines
 *   post   — extra journal lines contributed to the transaction's own entry
 *   period — a scheduled/manual sweep of pooled balances to targets
 *
 * Rules are versioned and effective-dated; a published version is frozen
 * (its `definition_hash` is stamped on every run and lineage row), so a
 * posted allocation can always be explained by the exact definition that
 * produced it. Drivers are a registry of measures (statistical journals, GL
 * activity/balance, native measures, manual tables, report definitions).
 * Every allocated line traces back through `allocation_lineage`.
 */

export const ALLOCATION_MODES = ["entry", "post", "period"] as const;
export const ALLOCATION_VERSION_STATUSES = ["draft", "published", "retired"] as const;
export const ALLOCATION_BOOK_SCOPES = ["primary", "all_posting", "books"] as const;
export const ALLOCATION_APPLY_POLICIES = ["automatic", "suggest", "manual"] as const;
export const ALLOCATION_SOURCE_MEASURES = ["period_activity", "period_end_balance", "ytd_activity"] as const;
export const ALLOCATION_BASIS_KINDS = ["fixed_percent", "driver", "stepped"] as const;
export const ALLOCATION_DRIVER_AS_OF = ["period", "document_date", "prior_period"] as const;
export const ALLOCATION_TARGET_KINDS = ["explicit", "dynamic"] as const;
export const ALLOCATION_IMPACTS = ["reclass", "net_zero_pair", "report_only"] as const;
export const ALLOCATION_RESIDUAL_POLICIES = ["largest_share", "first_target", "last_target", "explicit_target"] as const;
export const ALLOCATION_SOLVE_METHODS = ["sequential", "simultaneous"] as const;
export const ALLOCATION_RUN_POLICIES = ["manual", "auto_preview", "auto_post"] as const;
export const ALLOCATION_DRIVER_SOURCE_KINDS = [
  "statistical_journal",
  "gl_activity",
  "gl_balance",
  "native_measure",
  "manual",
  "report_definition",
] as const;
export const ALLOCATION_RUN_STATUSES = [
  "previewed",
  "pending_approval",
  "posted",
  "reversed",
  "failed",
  "superseded",
] as const;
export const ALLOCATION_RUN_TRIGGERS = ["manual", "scheduled", "close_automation", "rerun"] as const;
/** journal_lines.contributor_kind values; null means the posting kernel itself. */
export const JOURNAL_LINE_CONTRIBUTOR_KINDS = ["rule", "script", "app", "intercompany"] as const;

/** Rule head: identity, mode, waterfall order. Definitions live in versions. */
export const allocationRules = pgTable(
  "allocation_rules",
  {
    id: id(),
    orgId: orgRef(),
    /** Stable slug referenced by imports/API (`distributionKey`) and scripts. */
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    mode: text("mode", { enum: ALLOCATION_MODES }).notNull(),
    /** Waterfall / precedence order (lower first). */
    sortOrder: integer("sort_order").notNull().default(100),
    isActive: boolean("is_active").notNull().default(true),
    /** Engine-owned rules (e.g. the overhead net-zero pair): not deletable. */
    isSystem: boolean("is_system").notNull().default(false),
    /** The published version currently in force (null = nothing published). */
    currentVersionId: uuid("current_version_id"),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("allocation_rules_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("allocation_rules_org_key").on(t.orgId, t.key),
    index("allocation_rules_org_mode").on(t.orgId, t.mode, t.isActive, t.sortOrder),
    check("allocation_rules_key_slug", sql`${t.key} ~ '^[a-z0-9][a-z0-9_-]{0,63}$'`),
  ],
);

/** Driver registry: a measure per dimension value, evaluated per period/date. */
export const allocationDrivers = pgTable(
  "allocation_drivers",
  {
    id: id(),
    orgId: orgRef(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    unit: text("unit"),
    /** 'department' | 'location' | 'class' | 'project' | 'subsidiary' | 'extra:<segmentKey>' */
    dimension: text("dimension").notNull(),
    sourceKind: text("source_kind", { enum: ALLOCATION_DRIVER_SOURCE_KINDS }).notNull(),
    config: jsonb("config").notNull().default({}),
    isActive: boolean("is_active").notNull().default(true),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("allocation_drivers_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("allocation_drivers_org_key").on(t.orgId, t.key),
    check("allocation_drivers_key_slug", sql`${t.key} ~ '^[a-z0-9][a-z0-9_-]{0,63}$'`),
  ],
);

/** Immutable-once-published, effective-dated rule definition. */
export const allocationRuleVersions = pgTable(
  "allocation_rule_versions",
  {
    id: id(),
    orgId: orgRef(),
    ruleId: uuid("rule_id").notNull(),
    versionNo: integer("version_no").notNull(),
    status: text("status", { enum: ALLOCATION_VERSION_STATUSES }).notNull().default("draft"),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),

    // -- books ------------------------------------------------------------
    bookScope: text("book_scope", { enum: ALLOCATION_BOOK_SCOPES }).notNull().default("primary"),
    /** uuid[] of accounting_books when book_scope = 'books'. */
    bookIds: jsonb("book_ids").$type<string[]>().notNull().default([]),

    // -- applicability (entry/post) and source filter (period) -------------
    /** text[] of document kinds; null = any kind. */
    documentKinds: jsonb("document_kinds").$type<string[] | null>(),
    /** { kind:'any' } | { kind:'accounts', accountIds } | { kind:'account_group', dimension, groupKey } */
    accountScope: jsonb("account_scope").notNull().default({ kind: "any" }),
    /** AND of present keys; `requireUntagged` matches empty dimensions. */
    dimensionFilters: jsonb("dimension_filters").notNull().default({}),
    applyPolicy: text("apply_policy", { enum: ALLOCATION_APPLY_POLICIES }).notNull().default("manual"),
    sourceMeasure: text("source_measure", { enum: ALLOCATION_SOURCE_MEASURES }).notNull().default("period_activity"),

    // -- basis ---------------------------------------------------------------
    basisKind: text("basis_kind", { enum: ALLOCATION_BASIS_KINDS }).notNull().default("fixed_percent"),
    driverId: uuid("driver_id"),
    driverAsOf: text("driver_as_of", { enum: ALLOCATION_DRIVER_AS_OF }).notNull().default("period"),
    basisConfig: jsonb("basis_config").notNull().default({}),

    // -- targets -------------------------------------------------------------
    targetKind: text("target_kind", { enum: ALLOCATION_TARGET_KINDS }).notNull().default("explicit"),
    /** { dimension, include?, exclude?, minWeight?, targetAccountId? } when target_kind = 'dynamic'. */
    dynamicTarget: jsonb("dynamic_target").notNull().default({}),

    // -- impact --------------------------------------------------------------
    impact: text("impact", { enum: ALLOCATION_IMPACTS }).notNull().default("reclass"),
    offsetAccountId: uuid("offset_account_id"),
    residualPolicy: text("residual_policy", { enum: ALLOCATION_RESIDUAL_POLICIES }).notNull().default("largest_share"),
    residualTargetId: uuid("residual_target_id"),
    solveMethod: text("solve_method", { enum: ALLOCATION_SOLVE_METHODS }).notNull().default("sequential"),

    // -- scheduling (period) -------------------------------------------------
    runPolicy: text("run_policy", { enum: ALLOCATION_RUN_POLICIES }).notNull().default("manual"),
    runOffsetDays: integer("run_offset_days").notNull().default(0),
    approvalFlowId: uuid("approval_flow_id"),

    // -- presentation ---------------------------------------------------------
    memoTemplate: text("memo_template"),
    lineDescriptionTemplate: text("line_description_template"),

    // -- publication evidence -------------------------------------------------
    definitionHash: text("definition_hash"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: uuid("published_by"),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    retiredBy: uuid("retired_by"),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("allocation_rule_versions_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("allocation_rule_versions_rule_no").on(t.orgId, t.ruleId, t.versionNo),
    index("allocation_rule_versions_rule_status").on(t.orgId, t.ruleId, t.status, t.effectiveFrom),
    foreignKey({
      name: "allocation_rule_versions_rule_id_fkey",
      columns: [t.orgId, t.ruleId],
      foreignColumns: [allocationRules.orgId, allocationRules.id],
    }),
    foreignKey({
      name: "allocation_rule_versions_offset_account_id_fkey",
      columns: [t.orgId, t.offsetAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
    foreignKey({
      name: "allocation_rule_versions_driver_id_fkey",
      columns: [t.orgId, t.driverId],
      foreignColumns: [allocationDrivers.orgId, allocationDrivers.id],
    }),
    check("allocation_rule_versions_effective_window", sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`),
    check("allocation_rule_versions_run_offset", sql`${t.runOffsetDays} >= 0`),
    check(
      "allocation_rule_versions_published_hash",
      sql`${t.status} <> 'published' or ${t.definitionHash} is not null`,
    ),
  ],
);

/** Explicit targets of a version (ordered). */
export const allocationRuleTargets = pgTable(
  "allocation_rule_targets",
  {
    id: id(),
    orgId: orgRef(),
    versionId: uuid("version_id").notNull(),
    sequence: integer("sequence").notNull(),
    /** null = keep the source account. */
    targetAccountId: uuid("target_account_id"),
    departmentId: uuid("department_id"),
    locationId: uuid("location_id"),
    classId: uuid("class_id"),
    projectId: uuid("project_id"),
    /** null = same subsidiary as the source. */
    subsidiaryId: uuid("subsidiary_id"),
    extraDims: jsonb("extra_dims").notNull().default({}),
    /** fixed_percent basis: 0 < percent <= 100 unless is_remainder. */
    fixedPercent: numeric("fixed_percent", { precision: 19, scale: 4 }),
    /** manual weight (driver-less weighting); non-negative. */
    weight: numeric("weight", { precision: 19, scale: 4 }),
    isRemainder: boolean("is_remainder").notNull().default(false),
    label: text("label"),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("allocation_rule_targets_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("allocation_rule_targets_version_seq").on(t.orgId, t.versionId, t.sequence),
    foreignKey({
      name: "allocation_rule_targets_version_id_fkey",
      columns: [t.orgId, t.versionId],
      foreignColumns: [allocationRuleVersions.orgId, allocationRuleVersions.id],
    }),
    foreignKey({
      name: "allocation_rule_targets_target_account_id_fkey",
      columns: [t.orgId, t.targetAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
    foreignKey({
      name: "allocation_rule_targets_department_id_fkey",
      columns: [t.orgId, t.departmentId],
      foreignColumns: [departments.orgId, departments.id],
    }),
    foreignKey({
      name: "allocation_rule_targets_location_id_fkey",
      columns: [t.orgId, t.locationId],
      foreignColumns: [locations.orgId, locations.id],
    }),
    foreignKey({
      name: "allocation_rule_targets_class_id_fkey",
      columns: [t.orgId, t.classId],
      foreignColumns: [classes.orgId, classes.id],
    }),
    foreignKey({
      name: "allocation_rule_targets_project_id_fkey",
      columns: [t.orgId, t.projectId],
      foreignColumns: [projects.orgId, projects.id],
    }),
    foreignKey({
      name: "allocation_rule_targets_subsidiary_id_fkey",
      columns: [t.orgId, t.subsidiaryId],
      foreignColumns: [subsidiaries.orgId, subsidiaries.id],
    }),
    check(
      "allocation_rule_targets_percent_range",
      sql`${t.fixedPercent} is null or (${t.fixedPercent} > 0 and ${t.fixedPercent} <= 100)`,
    ),
    check("allocation_rule_targets_weight_nonneg", sql`${t.weight} is null or ${t.weight} >= 0`),
  ],
);

/** Manual driver values (effective-dated) per dimension value. */
export const allocationDriverValues = pgTable(
  "allocation_driver_values",
  {
    id: id(),
    orgId: orgRef(),
    driverId: uuid("driver_id").notNull(),
    dimensionValueId: uuid("dimension_value_id").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    value: numeric("value", { precision: 19, scale: 4 }).notNull(),
    note: text("note"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("allocation_driver_values_unique").on(t.orgId, t.driverId, t.dimensionValueId, t.effectiveFrom),
    index("allocation_driver_values_driver").on(t.orgId, t.driverId, t.effectiveFrom),
    foreignKey({
      name: "allocation_driver_values_driver_id_fkey",
      columns: [t.orgId, t.driverId],
      foreignColumns: [allocationDrivers.orgId, allocationDrivers.id],
    }),
    check("allocation_driver_values_window", sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`),
    check("allocation_driver_values_nonneg", sql`${t.value} >= 0`),
  ],
);

/** One computed/posted period-mode run. */
export const allocationRuns = pgTable(
  "allocation_runs",
  {
    id: id(),
    orgId: orgRef(),
    ruleId: uuid("rule_id").notNull(),
    versionId: uuid("version_id").notNull(),
    definitionHash: text("definition_hash").notNull(),
    periodId: uuid("period_id").notNull(),
    bookId: uuid("book_id").notNull(),
    /** null = every subsidiary in scope. */
    subsidiaryId: uuid("subsidiary_id"),
    status: text("status", { enum: ALLOCATION_RUN_STATUSES }).notNull(),
    triggerKind: text("trigger_kind", { enum: ALLOCATION_RUN_TRIGGERS }).notNull().default("manual"),
    sourceTotal: money("source_total").notNull().default("0"),
    allocatedTotal: money("allocated_total").notNull().default("0"),
    residual: money("residual").notNull().default("0"),
    journalEntryId: uuid("journal_entry_id"),
    reversalEntryId: uuid("reversal_entry_id"),
    reversesRunId: uuid("reverses_run_id"),
    supersededByRunId: uuid("superseded_by_run_id"),
    /** Full explain payload: sources, driver vector, per-target weight/share/amount/residual. */
    computation: jsonb("computation").notNull().default({}),
    /** sha256 of the canonical computation — equal fingerprints mean "nothing changed". */
    fingerprint: text("fingerprint"),
    error: text("error"),
    flowRunId: uuid("flow_run_id"),
    requestedBy: uuid("requested_by"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("allocation_runs_org_id_id_unique").on(t.orgId, t.id),
    index("allocation_runs_rule_period").on(t.orgId, t.ruleId, t.periodId, t.bookId),
    index("allocation_runs_status").on(t.orgId, t.status, t.createdAt),
    uniqueIndex("allocation_runs_one_posted")
      .on(t.orgId, t.ruleId, t.periodId, t.bookId, sql`coalesce(${t.subsidiaryId}, '00000000-0000-0000-0000-000000000000'::uuid)`)
      .where(sql`${t.status} = 'posted'`),
    foreignKey({
      name: "allocation_runs_rule_id_fkey",
      columns: [t.orgId, t.ruleId],
      foreignColumns: [allocationRules.orgId, allocationRules.id],
    }),
    foreignKey({
      name: "allocation_runs_version_id_fkey",
      columns: [t.orgId, t.versionId],
      foreignColumns: [allocationRuleVersions.orgId, allocationRuleVersions.id],
    }),
    foreignKey({
      name: "allocation_runs_period_id_fkey",
      columns: [t.orgId, t.periodId],
      foreignColumns: [accountingPeriods.orgId, accountingPeriods.id],
    }),
    foreignKey({
      name: "allocation_runs_book_id_fkey",
      columns: [t.orgId, t.bookId],
      foreignColumns: [accountingBooks.orgId, accountingBooks.id],
    }),
    foreignKey({
      name: "allocation_runs_subsidiary_id_fkey",
      columns: [t.orgId, t.subsidiaryId],
      foreignColumns: [subsidiaries.orgId, subsidiaries.id],
    }),
    foreignKey({
      name: "allocation_runs_journal_entry_id_fkey",
      columns: [t.orgId, t.journalEntryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
    }),
    foreignKey({
      name: "allocation_runs_reversal_entry_id_fkey",
      columns: [t.orgId, t.reversalEntryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
    }),
  ],
);

/** Every allocated line traces to its source line, rule version, and driver. */
export const allocationLineage = pgTable(
  "allocation_lineage",
  {
    id: id(),
    orgId: orgRef(),
    mode: text("mode", { enum: ALLOCATION_MODES }).notNull(),
    ruleId: uuid("rule_id").notNull(),
    versionId: uuid("version_id").notNull(),
    definitionHash: text("definition_hash").notNull(),
    runId: uuid("run_id"),
    documentId: uuid("document_id"),
    journalEntryId: uuid("journal_entry_id"),
    journalLineId: uuid("journal_line_id"),
    sourceJournalLineId: uuid("source_journal_line_id"),
    sourceDocumentLineId: uuid("source_document_line_id"),
    targetDocumentLineId: uuid("target_document_line_id"),
    /** Event trigger for event-bound post rules (the overhead net-zero pair): the approved time entry. */
    sourceTimeEntryId: uuid("source_time_entry_id"),
    driverId: uuid("driver_id"),
    driverValue: numeric("driver_value", { precision: 19, scale: 4 }),
    driverTotal: numeric("driver_total", { precision: 19, scale: 4 }),
    share: numeric("share", { precision: 19, scale: 10 }),
    amount: money("amount").notNull().default("0"),
    residual: money("residual").notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("allocation_lineage_entry").on(t.orgId, t.journalEntryId),
    index("allocation_lineage_run").on(t.orgId, t.runId),
    index("allocation_lineage_rule").on(t.orgId, t.ruleId, t.createdAt),
    index("allocation_lineage_document").on(t.orgId, t.documentId),
    index("allocation_lineage_time_entry")
      .on(t.orgId, t.sourceTimeEntryId)
      .where(sql`${t.sourceTimeEntryId} is not null`),
    foreignKey({
      name: "allocation_lineage_rule_id_fkey",
      columns: [t.orgId, t.ruleId],
      foreignColumns: [allocationRules.orgId, allocationRules.id],
    }),
    foreignKey({
      name: "allocation_lineage_version_id_fkey",
      columns: [t.orgId, t.versionId],
      foreignColumns: [allocationRuleVersions.orgId, allocationRuleVersions.id],
    }),
    foreignKey({
      name: "allocation_lineage_run_id_fkey",
      columns: [t.orgId, t.runId],
      foreignColumns: [allocationRuns.orgId, allocationRuns.id],
    }),
    foreignKey({
      name: "allocation_lineage_document_id_fkey",
      columns: [t.orgId, t.documentId],
      foreignColumns: [documents.orgId, documents.id],
    }),
    foreignKey({
      name: "allocation_lineage_journal_entry_id_fkey",
      columns: [t.orgId, t.journalEntryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
    }),
    foreignKey({
      name: "allocation_lineage_journal_line_id_fkey",
      columns: [t.orgId, t.journalLineId],
      foreignColumns: [journalLines.orgId, journalLines.id],
    }),
    foreignKey({
      name: "allocation_lineage_source_journal_line_id_fkey",
      columns: [t.orgId, t.sourceJournalLineId],
      foreignColumns: [journalLines.orgId, journalLines.id],
    }),
    foreignKey({
      name: "allocation_lineage_driver_id_fkey",
      columns: [t.orgId, t.driverId],
      foreignColumns: [allocationDrivers.orgId, allocationDrivers.id],
    }),
    foreignKey({
      name: "allocation_lineage_time_entry_id_fkey",
      columns: [t.orgId, t.sourceTimeEntryId],
      foreignColumns: [timeEntries.orgId, timeEntries.id],
      // Evidence follows its anchor, like the run/document lineage anchors.
    }).onDelete("cascade"),
    check(
      "allocation_lineage_anchor",
      sql`${t.runId} is not null or ${t.documentId} is not null or ${t.sourceTimeEntryId} is not null`,
    ),
  ],
);
