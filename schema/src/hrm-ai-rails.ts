import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
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
import { auditColumns, id, orgRef } from "./helpers";

/**
 * HRM AI rails (migration 0232). Every AI capability is a TOOL or a
 * DETERMINISTIC service; the LLM only phrases and drafts. Storage holds
 * the per-org capability mirror, the append-only decision log, the
 * deterministic anomaly flags with their cohort baselines, and the
 * natural-language report drafts (validated definitions, never SQL).
 *
 * - aiCapabilities: code-registry mirror; autonomy may only move DOWN.
 * - aiDecisions: append-only (the refuse-update trigger in 0232 rejects
 *   UPDATE/DELETE); digests are hashes, never prompts.
 * - payrollAnomalyFlags: idempotent rescan target; block severity refuses
 *   the pay-run commit while open.
 * - anomalyBaselines: per-cohort mean/stddev windows for baseline rules.
 * - nlReportDrafts: question plus validated report-engine definition.
 * - aiRailsSettings: org-declared thresholds, cohort, bias terms, cadence.
 */
export const aiCapabilities = pgTable(
  "ai_capabilities",
  {
    id: id(),
    orgId: orgRef(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    purpose: text("purpose").notNull(),
    dataScope: jsonb("data_scope").notNull().default({}),
    autonomy: text("autonomy").notNull().default("read_only"),
    reviewerRole: text("reviewer_role"),
    noticeRequired: boolean("notice_required").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true }),
    reviewedBy: uuid("reviewed_by"),
    ...auditColumns,
  },
  (t) => [
    check("ai_capabilities_autonomy", sql`autonomy IN ('read_only', 'draft', 'propose', 'act_with_confirmation')`),
    uniqueIndex("ai_capabilities_org_key_unique").on(t.orgId, t.key),
    index("ai_capabilities_org_enabled").on(t.orgId),
  ],
);

export const aiDecisions = pgTable(
  "ai_decisions",
  {
    id: id(),
    orgId: orgRef(),
    capabilityKey: text("capability_key").notNull(),
    actorUserId: uuid("actor_user_id").notNull(),
    subjectKind: text("subject_kind").notNull(),
    subjectId: uuid("subject_id"),
    inputDigest: text("input_digest").notNull(),
    outputDigest: text("output_digest").notNull(),
    outputSummary: text("output_summary").notNull(),
    sources: jsonb("sources").notNull().default([]),
    outcome: text("outcome").notNull(),
    humanReviewer: uuid("human_reviewer"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    model: text("model").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "ai_decisions_outcome",
      sql`outcome IN ('shown', 'accepted', 'edited', 'rejected', 'expired')`,
    ),
    index("ai_decisions_org_capability_recorded").on(t.orgId, t.capabilityKey, t.recordedAt),
    index("ai_decisions_org_actor").on(t.orgId, t.actorUserId, t.recordedAt),
  ],
);

export const payrollAnomalyFlags = pgTable(
  "payroll_anomaly_flags",
  {
    id: id(),
    orgId: orgRef(),
    runDocumentId: uuid("run_document_id"),
    payPeriodFrom: date("pay_period_from").notNull(),
    payPeriodTo: date("pay_period_to").notNull(),
    employmentId: uuid("employment_id"),
    kind: text("kind").notNull(),
    severity: text("severity").notNull(),
    detail: jsonb("detail").notNull().default({}),
    explanation: text("explanation").notNull(),
    status: text("status").notNull().default("open"),
    resolvedBy: uuid("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    reason: text("reason"),
    ...auditColumns,
  },
  (t) => [
    check(
      "payroll_anomaly_flags_kind",
      sql`kind IN ('terminated_with_pay', 'duplicate_bank', 'retro_spike', 'net_pay_spike', 'zero_hours_with_pay', 'hours_spike', 'missing_rate', 'expired_rate', 'prevailing_wage_missing', 'apprentice_ratio_breach', 'benefit_input_orphan', 'leave_input_orphan', 'negative_balance', 'duplicate_entry', 'geofence_outside', 'unrounded', 'custom')`,
    ),
    check("payroll_anomaly_flags_severity", sql`severity IN ('info', 'warn', 'block')`),
    check(
      "payroll_anomaly_flags_status",
      sql`status IN ('open', 'acknowledged', 'resolved', 'false_positive')`,
    ),
    index("payroll_anomaly_flags_org_period_status").on(
      t.orgId,
      t.payPeriodFrom,
      t.payPeriodTo,
      t.status,
    ),
    index("payroll_anomaly_flags_org_severity_status").on(t.orgId, t.severity, t.status),
  ],
);

export const anomalyBaselines = pgTable(
  "anomaly_baselines",
  {
    id: id(),
    orgId: orgRef(),
    cohortKey: text("cohort_key").notNull(),
    metric: text("metric").notNull(),
    windowPeriods: integer("window_periods").notNull(),
    mean: numeric("mean").notNull(),
    stddev: numeric("stddev").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns,
  },
  (t) => [
    check("anomaly_baselines_metric", sql`metric IN ('net_pay', 'hours', 'gross')`),
    uniqueIndex("anomaly_baselines_org_cohort_metric_unique").on(t.orgId, t.cohortKey, t.metric),
  ],
);

export const aiRailsSettings = pgTable("ai_rails_settings", {
  orgId: uuid("org_id").primaryKey(),
  zThreshold: numeric("z_threshold").notNull().default("3"),
  retroThreshold: numeric("retro_threshold").notNull().default("500"),
  cohortKey: text("cohort_key").notNull().default("subsidiary"),
  biasTerms: text("bias_terms").array().notNull().default([]),
  reviewMonths: integer("review_months").notNull().default(12),
  ...auditColumns,
});

export const nlReportDrafts = pgTable(
  "nl_report_drafts",
  {
    id: id(),
    orgId: orgRef(),
    userId: uuid("user_id").notNull(),
    question: text("question").notNull(),
    definition: jsonb("definition").notNull().default({}),
    status: text("status").notNull().default("drafted"),
    savedReportId: uuid("saved_report_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("nl_report_drafts_status", sql`status IN ('drafted', 'saved', 'discarded')`),
    index("nl_report_drafts_org_user").on(t.orgId, t.userId, t.createdAt),
  ],
);
