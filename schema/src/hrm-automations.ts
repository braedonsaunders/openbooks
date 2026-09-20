import { sql } from "drizzle-orm";
import {
  boolean,
  check,
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
 * HRM automations (migrations 0226/0227).
 *
 * The trigger side Flows lacks: time, date-relative, field-change,
 * document and approvable-event triggers firing versioned
 * trigger/rule/condition/action recipes. Flows keeps every gate,
 * delegation, escalation and subject adapter; this module only decides
 * WHEN a recipe fires and WHAT ordered steps it runs.
 *
 * - automations / automation_trigger_shapes: the recipe. trigger is a
 *   zod-validated discriminated union (six kinds); SQL pins the kind
 *   vocabulary so storage and the service cannot drift. version bumps on
 *   every edit; runs record the version they executed.
 * - automation_runs: the append-only run log. The UNIQUE on
 *   (org, automation, subject_kind, subject_id, trigger_fingerprint) is
 *   the idempotency key — a re-fired trigger collapses onto one row.
 * - automation_approval_settings: per-subject exception-only tuning over
 *   the EXISTING Flows gates (never a second gate).
 * - automation_event_queue: durable in-transaction staging rows written
 *   by entity write services; the tick drains them. Never an inline call.
 * - hrm_action_reasons: Setup-owned reason codes per generic HR action.
 *
 * SQL-only edges (documented, not declared): automation_runs →
 * automations(id) (declared below), actors → users(id) (home-org
 * pattern), 0227 verb-link columns → employment_changes(id)
 * (same-org provenance is enforced by the service over the loaded
 * rows — FKs alone cannot express it — matching the 0184 stance).
 */

export const AUTOMATION_STATUSES = ["draft", "enabled", "disabled", "error"] as const;

export const AUTOMATION_TRIGGER_KINDS = [
  "schedule",
  "date_relative",
  "field_change",
  "event",
  "document",
  "manual",
] as const;

export const AUTOMATION_RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "skipped_no_match",
  "simulated",
] as const;

export const AUTOMATION_ACTION_KINDS = [
  "create_task",
  "send_email",
  "send_notification",
  "start_process",
  "start_flow",
  "update_field",
  "webhook",
  "delay",
  "approve_step",
] as const;

export const HRM_ACTIONS = [
  "hire",
  "rehire",
  "transfer",
  "promotion",
  "demotion",
  "pay_change",
  "manager_change",
  "location_change",
  "schedule_change",
  "leave_of_absence",
  "return",
  "termination",
  "profile_change",
  "other",
] as const;

export const EMPLOYMENT_CHANGE_VERBS = ["apply", "cancel", "rescind", "correct"] as const;

export const automations = pgTable(
  "automations",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status", { enum: AUTOMATION_STATUSES }).notNull().default("draft"),
    trigger: jsonb("trigger").$type<Record<string, unknown>>().notNull().default({}),
    rules: jsonb("rules").$type<Record<string, unknown>>().notNull().default({}),
    conditions: jsonb("conditions").$type<Record<string, unknown>>().notNull().default({}),
    actions: jsonb("actions").$type<unknown[]>().notNull().default([]),
    priority: integer("priority").notNull().default(100),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    errorMessage: text("error_message"),
    version: integer("version").notNull().default(1),
    ...auditColumns,
  },
  (t) => [
    check("automations_status", sql`${t.status} IN ('draft', 'enabled', 'disabled', 'error')`),
    check("automations_name", sql`char_length(btrim(${t.name})) > 0`),
    check(
      "automations_trigger_shape",
      sql`jsonb_typeof(${t.trigger}) = 'object' AND ${t.trigger} ? 'kind'`,
    ),
    check("automations_rules_shape", sql`jsonb_typeof(${t.rules}) = 'object'`),
    check("automations_conditions_shape", sql`jsonb_typeof(${t.conditions}) = 'object'`),
    check("automations_actions_shape", sql`jsonb_typeof(${t.actions}) = 'array'`),
    check("automations_version_floor", sql`${t.version} >= 1`),
    uniqueIndex("automations_org_name_unique").on(t.orgId, t.name),
    index("automations_org_status").on(t.orgId, t.status),
  ],
);

export const automationRuns = pgTable(
  "automation_runs",
  {
    id: id(),
    orgId: orgRef(),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id),
    version: integer("version").notNull(),
    triggerPayload: jsonb("trigger_payload").$type<Record<string, unknown>>().notNull().default({}),
    subjectKind: text("subject_kind"),
    subjectId: uuid("subject_id"),
    status: text("status", { enum: AUTOMATION_RUN_STATUSES }).notNull().default("queued"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: jsonb("error").$type<Record<string, unknown> | null>(),
    steps: jsonb("steps").$type<unknown[]>().notNull().default([]),
    triggerFingerprint: text("trigger_fingerprint").notNull().default(""),
    ...auditColumns,
  },
  (t) => [
    check(
      "automation_runs_status",
      sql`${t.status} IN ('queued', 'running', 'succeeded', 'failed', 'skipped_no_match', 'simulated')`,
    ),
    check("automation_runs_version_floor", sql`${t.version} >= 1`),
    check("automation_runs_steps_shape", sql`jsonb_typeof(${t.steps}) = 'array'`),
    uniqueIndex("automation_runs_idempotency_unique").on(
      t.orgId,
      t.automationId,
      t.subjectKind,
      t.subjectId,
      t.triggerFingerprint,
    ),
    index("automation_runs_automation").on(t.orgId, t.automationId),
    index("automation_runs_status").on(t.orgId, t.status),
  ],
);

export const automationApprovalSettings = pgTable(
  "automation_approval_settings",
  {
    id: id(),
    orgId: orgRef(),
    subjectKind: text("subject_kind").notNull(),
    exceptionOnly: boolean("exception_only").notNull().default(false),
    thresholds: jsonb("thresholds").$type<Record<string, unknown>>().notNull().default({}),
    autoApproveWhenNoRule: boolean("auto_approve_when_no_rule").notNull().default(false),
    delegateAfterDays: integer("delegate_after_days"),
    excludeInitiator: boolean("exclude_initiator").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    check(
      "automation_approval_settings_subject",
      sql`char_length(btrim(${t.subjectKind})) > 0`,
    ),
    check(
      "automation_approval_settings_thresholds",
      sql`jsonb_typeof(${t.thresholds}) = 'object'`,
    ),
    uniqueIndex("automation_approval_settings_org_subject_unique").on(t.orgId, t.subjectKind),
  ],
);

export const automationEventQueue = pgTable(
  "automation_event_queue",
  {
    id: id(),
    orgId: orgRef(),
    eventKind: text("event_kind").notNull(),
    subjectKind: text("subject_kind"),
    subjectId: uuid("subject_id"),
    triggerFingerprint: text("trigger_fingerprint").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status", { enum: ["pending", "claimed", "done", "failed"] })
      .notNull()
      .default("pending"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "automation_event_queue_status",
      sql`${t.status} IN ('pending', 'claimed', 'done', 'failed')`,
    ),
    uniqueIndex("automation_event_queue_dedupe_unique").on(
      t.orgId,
      t.eventKind,
      t.subjectKind,
      t.subjectId,
      t.triggerFingerprint,
    ),
    index("automation_event_queue_pending").on(t.status),
  ],
);

export const hrmActionReasons = pgTable(
  "hrm_action_reasons",
  {
    id: id(),
    orgId: orgRef(),
    action: text("action", { enum: HRM_ACTIONS }).notNull(),
    reasonCode: text("reason_code").notNull(),
    label: text("label").notNull(),
    requiresComment: boolean("requires_comment").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    check("hrm_action_reasons_code", sql`char_length(btrim(${t.reasonCode})) > 0`),
    check("hrm_action_reasons_label", sql`char_length(btrim(${t.label})) > 0`),
    uniqueIndex("hrm_action_reasons_org_action_code_unique").on(t.orgId, t.action, t.reasonCode),
    index("hrm_action_reasons_org_action").on(t.orgId, t.action),
  ],
);
