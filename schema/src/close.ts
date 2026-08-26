import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/** Tenant-owned fiscal-calendar definition. Period rows are generated from a
 * versioned calendar instead of inferring calendar rules from their dates. */
export const fiscalCalendars = pgTable(
  "fiscal_calendars",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    cadence: text("cadence", {
      enum: [
        "monthly",
        "four_four_five",
        "four_five_four",
        "five_four_four",
        "thirteen_period",
        "custom",
      ],
    })
      .notNull()
      .default("monthly"),
    yearStartMonth: integer("year_start_month").notNull().default(1),
    weekStartsOn: integer("week_starts_on").notNull().default(1),
    /** Anchor for week-based calendars. Required by the service for 4-4-5
     * variants; null for date-month calendars. */
    anchorDate: date("anchor_date"),
    timeZone: text("time_zone").notNull().default("UTC"),
    adjustmentPeriodEnabled: boolean("adjustment_period_enabled")
      .notNull()
      .default(false),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    config: jsonb("config").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("fiscal_calendars_org_name").on(t.orgId, t.name),
    index("fiscal_calendars_org_active").on(t.orgId, t.isActive),
  ],
);

/** Lock state is book/module/entity scoped and independent of period identity.
 * A null subsidiary is the tenant-wide default; a subsidiary-specific row
 * overrides it for that entity. */
export const periodLocks = pgTable(
  "period_locks",
  {
    id: id(),
    orgId: orgRef(),
    periodId: uuid("period_id").notNull(),
    bookId: uuid("book_id").notNull(),
    subsidiaryId: uuid("subsidiary_id"),
    module: text("module", {
      enum: ["ar", "ap", "banking", "assets", "tax", "gl"],
    }).notNull(),
    state: text("state", { enum: ["open", "soft_closed", "closed"] })
      .notNull()
      .default("open"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: uuid("locked_by"),
    reason: text("reason"),
    reopenExpiresAt: timestamp("reopen_expires_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    ...auditColumns,
  },
  (t) => [
    unique("period_locks_scope")
      .on(t.orgId, t.periodId, t.bookId, t.subsidiaryId, t.module)
      .nullsNotDistinct(),
    index("period_locks_lookup").on(
      t.orgId,
      t.periodId,
      t.bookId,
      t.module,
      t.subsidiaryId,
    ),
  ],
);

export const closeBlueprints = pgTable(
  "close_blueprints",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    description: text("description"),
    periodType: text("period_type", {
      enum: ["month", "quarter", "year", "adjustment", "any"],
    })
      .notNull()
      .default("any"),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    version: integer("version").notNull().default(1),
    scopeRules: jsonb("scope_rules").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("close_blueprints_org_name_version").on(
      t.orgId,
      t.name,
      t.version,
    ),
  ],
);

export const closeBlueprintSteps = pgTable(
  "close_blueprint_steps",
  {
    id: id(),
    orgId: orgRef(),
    blueprintId: uuid("blueprint_id").notNull(),
    key: text("key").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    workstream: text("workstream", {
      enum: [
        "readiness",
        "banking",
        "ar",
        "ap",
        "assets",
        "tax",
        "payroll",
        "intercompany",
        "gl",
        "review",
        "publish",
      ],
    }).notNull(),
    taskType: text("task_type", {
      enum: [
        "check",
        "action",
        "reconciliation",
        "journal",
        "approval",
        "report",
        "publish",
      ],
    })
      .notNull()
      .default("action"),
    completionMode: text("completion_mode", {
      enum: ["manual", "computed", "automatic"],
    })
      .notNull()
      .default("manual"),
    gateType: text("gate_type", { enum: ["none", "soft", "hard"] })
      .notNull()
      .default("none"),
    dueOffsetBusinessDays: integer("due_offset_business_days")
      .notNull()
      .default(0),
    evidenceRequired: boolean("evidence_required").notNull().default(false),
    defaultOwnerRoleKey: text("default_owner_role_key"),
    defaultReviewerRoleKey: text("default_reviewer_role_key"),
    sortOrder: integer("sort_order").notNull().default(0),
    applicability: jsonb("applicability").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("close_blueprint_steps_key").on(t.blueprintId, t.key),
    index("close_blueprint_steps_order").on(t.blueprintId, t.sortOrder),
  ],
);

export const closeBlueprintDependencies = pgTable(
  "close_blueprint_dependencies",
  {
    id: id(),
    orgId: orgRef(),
    blueprintId: uuid("blueprint_id").notNull(),
    stepId: uuid("step_id").notNull(),
    dependsOnStepId: uuid("depends_on_step_id").notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("close_blueprint_dependency_unique").on(
      t.stepId,
      t.dependsOnStepId,
    ),
    index("close_blueprint_dependencies_blueprint").on(t.blueprintId),
  ],
);

export const closePolicies = pgTable(
  "close_policies",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    policyType: text("policy_type", {
      enum: ["materiality", "lock", "review", "segregation", "exception"],
    }).notNull(),
    rules: jsonb("rules").notNull().default({}),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [uniqueIndex("close_policies_org_code").on(t.orgId, t.code)],
);

export const closeAutomationRules = pgTable(
  "close_automation_rules",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    trigger: text("trigger", {
      enum: [
        "run_started",
        "task_ready",
        "exception_opened",
        "deadline_approaching",
        "run_closed",
      ],
    }).notNull(),
    action: text("action", {
      enum: [
        "notify",
        "assign",
        "run_check",
        "complete_task",
        "create_task",
        "generate_report",
        "start_flow",
      ],
    }).notNull(),
    conditions: jsonb("conditions").notNull().default({}),
    config: jsonb("config").notNull().default({}),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    index("close_automation_org_trigger").on(t.orgId, t.trigger, t.isActive),
  ],
);

/** Idempotent execution claims make event automation safe across retries and
 * horizontally scaled scheduler processes. Each running claim holds a random
 * fencing lease: a crashed claim is reclaimed (compare-and-set over the stored
 * token) by the next firing of its event, and each non-idempotent unit effect
 * commits in the same transaction as its `stages` checkpoint so a recovered
 * attempt converges on exactly once instead of duplicating partial effects. */
export const closeAutomationExecutions = pgTable(
  "close_automation_executions",
  {
    id: id(),
    orgId: orgRef(),
    ruleId: uuid("rule_id").notNull(),
    runId: uuid("run_id").notNull(),
    taskId: uuid("task_id"),
    trigger: text("trigger").notNull(),
    eventKey: text("event_key").notNull(),
    status: text("status", { enum: ["running", "completed", "failed"] })
      .notNull()
      .default("running"),
    error: text("error"),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    leaseToken: uuid("lease_token"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    stages: jsonb("stages").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("close_automation_execution_once").on(t.ruleId, t.eventKey),
    index("close_automation_executions_run").on(t.runId, t.createdAt),
  ],
);

export const closeReportingPackages = pgTable(
  "close_reporting_packages",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    description: text("description"),
    reports: jsonb("reports").notNull().default([]),
    recipients: jsonb("recipients").notNull().default([]),
    delivery: jsonb("delivery").notNull().default({}),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [uniqueIndex("close_reporting_packages_org_name").on(t.orgId, t.name)],
);

export const closeRuns = pgTable(
  "close_runs",
  {
    id: id(),
    orgId: orgRef(),
    periodId: uuid("period_id").notNull(),
    bookId: uuid("book_id").notNull(),
    blueprintId: uuid("blueprint_id").notNull(),
    reportingPackageId: uuid("reporting_package_id"),
    status: text("status", {
      enum: [
        "draft",
        "in_progress",
        "review",
        "approved",
        "closed",
        "published",
        "cancelled",
      ],
    })
      .notNull()
      .default("draft"),
    currentStage: text("current_stage", {
      enum: ["scope", "readiness", "execute", "review", "lock", "publish"],
    })
      .notNull()
      .default("scope"),
    targetCloseDate: date("target_close_date").notNull(),
    scope: jsonb("scope").notNull().default({}),
    readinessScore: integer("readiness_score").notNull().default(0),
    dataFingerprint: text("data_fingerprint"),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    startedBy: uuid("started_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: uuid("published_by"),
    /** Immutable point-in-time audit package frozen at publication. */
    binderSnapshot: jsonb("binder_snapshot"),
    binderHash: text("binder_hash"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("close_runs_period_book").on(t.orgId, t.periodId, t.bookId),
    index("close_runs_org_status").on(t.orgId, t.status, t.targetCloseDate),
  ],
);

export const closeRunTasks = pgTable(
  "close_run_tasks",
  {
    id: id(),
    orgId: orgRef(),
    runId: uuid("run_id").notNull(),
    blueprintStepId: uuid("blueprint_step_id"),
    key: text("key").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    workstream: text("workstream").notNull(),
    taskType: text("task_type").notNull(),
    completionMode: text("completion_mode").notNull(),
    gateType: text("gate_type").notNull(),
    status: text("status", {
      enum: [
        "blocked",
        "ready",
        "in_progress",
        "submitted",
        "changes_requested",
        "complete",
        "waived",
        "invalidated",
      ],
    })
      .notNull()
      .default("blocked"),
    sortOrder: integer("sort_order").notNull().default(0),
    ownerId: uuid("owner_id"),
    reviewerId: uuid("reviewer_id"),
    dueOn: date("due_on"),
    evidenceRequired: boolean("evidence_required").notNull().default(false),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedBy: uuid("completed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: uuid("reviewed_by"),
    dataFingerprint: text("data_fingerprint"),
    result: jsonb("result").notNull().default({}),
    notes: text("notes"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("close_run_tasks_key").on(t.runId, t.key),
    index("close_run_tasks_worklist").on(t.orgId, t.ownerId, t.status, t.dueOn),
    index("close_run_tasks_run_order").on(t.runId, t.sortOrder),
  ],
);

export const closeTaskEvidence = pgTable(
  "close_task_evidence",
  {
    id: id(),
    orgId: orgRef(),
    runId: uuid("run_id").notNull(),
    taskId: uuid("task_id").notNull(),
    fileId: uuid("file_id"),
    evidenceType: text("evidence_type", {
      enum: ["file", "report", "journal", "reconciliation", "link", "note"],
    }).notNull(),
    referenceId: uuid("reference_id"),
    referenceUrl: text("reference_url"),
    label: text("label").notNull(),
    snapshot: jsonb("snapshot").notNull().default({}),
    contentHash: text("content_hash"),
    ...auditColumns,
  },
  (t) => [index("close_task_evidence_task").on(t.taskId, t.createdAt)],
);

export const closeExceptions = pgTable(
  "close_exceptions",
  {
    id: id(),
    orgId: orgRef(),
    runId: uuid("run_id").notNull(),
    taskId: uuid("task_id"),
    code: text("code").notNull(),
    category: text("category").notNull(),
    severity: text("severity", {
      enum: ["info", "warning", "error", "critical"],
    }).notNull(),
    status: text("status", { enum: ["open", "resolved", "waived"] })
      .notNull()
      .default("open"),
    title: text("title").notNull(),
    message: text("message").notNull(),
    source: text("source").notNull().default("system"),
    details: jsonb("details").notNull().default({}),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by"),
    resolution: text("resolution"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("close_exceptions_run_code").on(t.runId, t.code),
    index("close_exceptions_run_status").on(t.runId, t.status, t.severity),
  ],
);

export const closeSignoffs = pgTable(
  "close_signoffs",
  {
    id: id(),
    orgId: orgRef(),
    runId: uuid("run_id").notNull(),
    taskId: uuid("task_id"),
    signoffType: text("signoff_type", {
      enum: ["prepare", "review", "approve", "waive", "publish"],
    }).notNull(),
    decision: text("decision", {
      enum: ["approved", "rejected", "waived"],
    }).notNull(),
    comment: text("comment"),
    dataFingerprint: text("data_fingerprint"),
    signedBy: uuid("signed_by").notNull(),
    signedAt: timestamp("signed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("close_signoffs_run").on(t.runId, t.signedAt)],
);

export const closeReopenRequests = pgTable(
  "close_reopen_requests",
  {
    id: id(),
    orgId: orgRef(),
    periodId: uuid("period_id").notNull(),
    bookId: uuid("book_id").notNull(),
    subsidiaryId: uuid("subsidiary_id"),
    modules: jsonb("modules").$type<string[]>().notNull().default([]),
    reason: text("reason").notNull(),
    impactSnapshot: jsonb("impact_snapshot").notNull().default({}),
    status: text("status", {
      enum: ["requested", "approved", "rejected", "expired", "reclosed"],
    })
      .notNull()
      .default("requested"),
    requestedBy: uuid("requested_by").notNull(),
    approvedBy: uuid("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    reclosedAt: timestamp("reclosed_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    index("close_reopen_requests_status").on(t.orgId, t.status, t.createdAt),
  ],
);

/** Append-only event stream for timeline, audit binder, notifications, and
 * future close-duration learning. */
export const closeEvents = pgTable(
  "close_events",
  {
    id: id(),
    orgId: orgRef(),
    runId: uuid("run_id"),
    taskId: uuid("task_id"),
    eventType: text("event_type").notNull(),
    actorId: uuid("actor_id"),
    payload: jsonb("payload").notNull().default({}),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("close_events_run_at").on(t.runId, t.at)],
);
