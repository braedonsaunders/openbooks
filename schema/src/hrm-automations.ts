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
  uniqueIndex
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
