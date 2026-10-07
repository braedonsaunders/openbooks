import { sql } from "drizzle-orm";
import {
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
import { orgs } from "./core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * Employer-defined benefit programs, membership, awards, and program sources
 * (migration 0469).
 *
 * Existing insured benefit plans (hrm_benefit_plans) stay authoritative for
 * health and retirement. This model stores employer-defined programs for
 * rewards, allowances, incentives, and custom programs: one program row with
 * typed rule columns (no mutable JSON rules), a typed scope child table for
 * department and project measurement scope, membership rows binding
 * employments to a program over effective dates, award rows recording each
 * issuance with immutable program and source snapshots, and a typed child
 * table naming the funding source accounts. Snapshot JSON carries evidence
 * only, never live rules.
 */

export const BENEFIT_PROGRAM_FAMILIES = ["reward", "allowance", "incentive", "custom"] as const;
export const BENEFIT_PROGRAM_STATUSES = ["draft", "active", "closed"] as const;
export const BENEFIT_PROGRAM_APPROVAL_MODES = ["none", "flows"] as const;
export const BENEFIT_PROGRAM_DELIVERY = ["payroll", "external"] as const;
export const BENEFIT_PROGRAM_VALUATION = ["fixed", "percent", "pool", "per_unit"] as const;
export const BENEFIT_PROGRAM_METRICS = [
  "revenue",
  "gross_profit",
  "net_profit",
  "approved_hours",
  "transactions",
] as const;
export const BENEFIT_PROGRAM_SCOPES = ["company", "department", "project"] as const;
export const BENEFIT_PROGRAM_ALLOCATIONS = ["equal", "hours", "role", "responsibility"] as const;
export const BENEFIT_PROGRAM_FREQUENCIES = [
  "monthly",
  "quarterly",
  "annual",
  "project_complete",
  "manual",
] as const;
export const BENEFIT_PROGRAM_PERIOD_BASES = ["calendar", "fiscal"] as const;
export const BENEFIT_AWARD_SUBJECT_KIND = "hrm_benefit_award";
export const BENEFIT_AWARD_STATUSES = [
  "draft",
  "pending",
  "rejected",
  "approved",
  "queued",
  "delivered",
  "voided",
] as const;

/** Employer-defined program header with typed rule columns. */
export const benefitPrograms = pgTable(
  "hrm_benefit_programs",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    family: text("family", { enum: [...BENEFIT_PROGRAM_FAMILIES] }).notNull(),
    description: text("description"),
    legalEntityId: uuid("legal_entity_id"),
    currency: text("currency").notNull(),
    status: text("status", { enum: [...BENEFIT_PROGRAM_STATUSES] })
      .notNull()
      .default("draft"),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    payComponentId: uuid("pay_component_id"),
    approvalMode: text("approval_mode", { enum: [...BENEFIT_PROGRAM_APPROVAL_MODES] }).notNull().default("none"),
    deliveryMethod: text("delivery_method", { enum: [...BENEFIT_PROGRAM_DELIVERY] })
      .notNull()
      .default("payroll"),
    valuation: text("valuation", { enum: [...BENEFIT_PROGRAM_VALUATION] })
      .notNull()
      .default("fixed"),
    metric: text("metric", { enum: [...BENEFIT_PROGRAM_METRICS] }),
    metricScope: text("metric_scope", { enum: [...BENEFIT_PROGRAM_SCOPES] }),
    allocation: text("allocation", { enum: [...BENEFIT_PROGRAM_ALLOCATIONS] })
      .notNull()
      .default("equal"),
    percentRate: numeric("percent_rate", { precision: 19, scale: 4 }),
    fixedAmount: numeric("fixed_amount", { precision: 19, scale: 4 }),
    capAmount: numeric("cap_amount", { precision: 19, scale: 4 }),
    budgetAmount: numeric("budget_amount", { precision: 19, scale: 4 }),
    thresholdAmount: numeric("threshold_amount", { precision: 19, scale: 4 }),
    frequency: text("frequency", { enum: [...BENEFIT_PROGRAM_FREQUENCIES] })
      .notNull()
      .default("manual"),
    periodBasis: text("period_basis", { enum: [...BENEFIT_PROGRAM_PERIOD_BASES] }),
    paymentDelayDays: integer("payment_delay_days").notNull().default(0),
    revision: integer("revision").notNull().default(1),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_benefit_programs_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }).onDelete("restrict"),
    uniqueIndex("hrm_benefit_programs_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_benefit_programs_org_code_unique").on(t.orgId, t.code),
    index("hrm_benefit_programs_org").on(t.orgId),
    index("hrm_benefit_programs_status").on(t.orgId, t.status),
    check("hrm_benefit_programs_code", sql`char_length(btrim(${t.code})) > 0`),
    check("hrm_benefit_programs_name", sql`char_length(btrim(${t.name})) > 0`),
    check("hrm_benefit_programs_currency", sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check("hrm_benefit_programs_window", sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`),
    check("hrm_benefit_programs_delay", sql`${t.paymentDelayDays} >= 0`),
    check("hrm_benefit_programs_approval_mode", sql`${t.approvalMode} in ('none','flows')`),
    check("hrm_benefit_programs_revision", sql`${t.revision} >= 1`),
  ],
);

/**
 * Measurement scope per program (typed child table with composite tenant
 * references). Company scope carries no rows; department scope names
 * departments; project scope names projects. Each row names exactly one
 * scoped entity so every reference resolves through a tenant key.
 */
export const benefitProgramScopes = pgTable(
  "hrm_benefit_program_scopes",
  {
    id: id(),
    orgId: orgRef(),
    programId: uuid("program_id").notNull(),
    departmentId: uuid("department_id"),
    projectId: uuid("project_id"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_benefit_program_scopes_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }).onDelete("restrict"),
    uniqueIndex("hrm_benefit_program_scopes_org_id_id_unique").on(t.orgId, t.id),
    index("hrm_benefit_program_scopes_program").on(t.orgId, t.programId),
    check(
      "hrm_benefit_program_scopes_one_entity",
      sql`(${t.departmentId} is not null)::int + (${t.projectId} is not null)::int = 1`,
    ),
  ],
);

/** Funding source accounts per program (typed child table). */
export const benefitProgramSources = pgTable(
  "hrm_benefit_program_sources",
  {
    id: id(),
    orgId: orgRef(),
    programId: uuid("program_id").notNull(),
    accountId: uuid("account_id").notNull(),
    weightBps: integer("weight_bps"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_benefit_program_sources_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }).onDelete("restrict"),
    uniqueIndex("hrm_benefit_program_sources_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_benefit_program_sources_org_program_account_unique").on(
      t.orgId,
      t.programId,
      t.accountId,
    ),
    index("hrm_benefit_program_sources_program").on(t.orgId, t.programId),
  ],
);

/** Program membership over effective dates with employment link. */
export const benefitProgramMembers = pgTable(
  "hrm_benefit_program_members",
  {
    id: id(),
    orgId: orgRef(),
    programId: uuid("program_id").notNull(),
    employmentId: uuid("employment_id").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    weight: numeric("weight", { precision: 19, scale: 4 }),
    role: text("role"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_benefit_program_members_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }).onDelete("restrict"),
    uniqueIndex("hrm_benefit_program_members_org_id_id_unique").on(t.orgId, t.id),
    index("hrm_benefit_program_members_program").on(t.orgId, t.programId),
    index("hrm_benefit_program_members_employment").on(t.orgId, t.employmentId),
    check(
      "hrm_benefit_program_members_window",
      sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
  ],
);

/** Each issuance with immutable snapshots, lifecycle status, and linkage. */
export const benefitAwards = pgTable(
  "hrm_benefit_awards",
  {
    id: id(),
    orgId: orgRef(),
    programId: uuid("program_id").notNull(),
    employmentId: uuid("employment_id").notNull(),
    periodFrom: date("period_from").notNull(),
    periodTo: date("period_to"),
    value: numeric("value", { precision: 19, scale: 4 }).notNull(),
    currency: text("currency").notNull(),
    status: text("status", { enum: [...BENEFIT_AWARD_STATUSES] })
      .notNull()
      .default("draft"),
    programSnapshot: jsonb("program_snapshot").$type<Record<string, unknown>>().notNull(),
    sourceSnapshot: jsonb("source_snapshot").$type<Record<string, unknown>>().notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>(),
    sourceKey: text("source_key"),
    adjustsAwardId: uuid("adjusts_award_id"),
    externalRef: text("external_ref"),
    payRunDocumentId: uuid("pay_run_document_id"),
    payRunAdjustmentId: uuid("pay_run_adjustment_id"),
    flowRunId: uuid("flow_run_id"),
    submittedBy: uuid("submitted_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    decisionSnapshot: jsonb("decision_snapshot").$type<Record<string, unknown>>(),
    approvedBy: uuid("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    voidReason: text("void_reason"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_benefit_awards_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }).onDelete("restrict"),
    uniqueIndex("hrm_benefit_awards_org_id_id_unique").on(t.orgId, t.id),
    index("hrm_benefit_awards_program").on(t.orgId, t.programId),
    index("hrm_benefit_awards_employment").on(t.orgId, t.employmentId),
    index("hrm_benefit_awards_status").on(t.orgId, t.status),
    check("hrm_benefit_awards_value", sql`${t.value} >= 0`),
    check("hrm_benefit_awards_currency", sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      "hrm_benefit_awards_window",
      sql`${t.periodTo} is null or ${t.periodTo} >= ${t.periodFrom}`,
    ),
    check(
      "hrm_benefit_awards_snapshots",
      sql`jsonb_typeof(${t.programSnapshot}) = 'object' and jsonb_typeof(${t.sourceSnapshot}) = 'object'`,
    ),
  ],
);

/** Append-only award lifecycle evidence. */
export const benefitAwardEvents = pgTable(
  "hrm_benefit_award_events",
  {
    id: id(),
    orgId: orgRef(),
    awardId: uuid("award_id").notNull(),
    kind: text("kind").notNull(),
    reason: text("reason").notNull(),
    actor: uuid("actor"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_benefit_award_events_org_id_fkey",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }).onDelete("restrict"),
    uniqueIndex("hrm_benefit_award_events_org_id_id_unique").on(t.orgId, t.id),
    index("hrm_benefit_award_events_award").on(t.orgId, t.awardId),
    check("hrm_benefit_award_events_reason", sql`char_length(btrim(${t.reason})) > 0`),
  ],
);
