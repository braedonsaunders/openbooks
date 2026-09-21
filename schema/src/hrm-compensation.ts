import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { departments, orgs } from "./core";
import { files } from "./file-cabinet";
import { auditColumns, id, orgRef } from "./helpers";
import { subsidiaries } from "./subsidiaries";
import { workerEmployments } from "./hrm";
import { positions } from "./hrm-positions";
import { parties } from "./parties";

/**
 * HRM compensation (migrations 0221/0222).
 *
 * What a role SHOULD pay (families, levels, versioned bands), how a raise
 * is decided (cycles with snapshotted lines and an append-only event
 * ledger, frozen statements), what the workforce will cost (headcount
 * plans with computed line costs), and whether pay is equitable (frozen
 * gap snapshots, information requests).
 *
 * - hrm_job_families / hrm_job_levels are CONFIGURATION: stable per-org
 *   codes, NULL family = the org-wide ladder. A level never moves
 *   ladders; the ladder-rank and per-ladder code uniques are partial
 *   indexes (Drizzle has no partial-unique primitive) and live in SQL.
 * - hrm_pay_bands are versioned SHOULD-pay rows with a scope-overlap
 *   GiST exclusion in SQL; Drizzle declares the columns and tenant FKs.
 * - hrm_comp_cycles / budgets / lines / events / statements are HISTORY:
 *   lines snapshot the payroll-side wage at open; events are append-only;
 *   statements are frozen rows. Push writes through the canonical
 *   labor_cost_rates writer and links pushed_rate_id (single-column FK to
 *   the rates primary key — the baseline table has no UNIQUE (org_id,
 *   id) for a composite FK; cross-org safety is RLS plus a service
 *   check that the rate row's org matches the cycle's).
 * - SQL-only edges (documented, not declared): scope slot generated
 *   columns, the exclusion constraint, partial uniques, the
 *   immutability triggers, and actor columns → users(id).
 */

export const HRM_COMP_CYCLE_SUBJECT_KIND = "hrm_comp_cycle";

export const COMP_CYCLE_KINDS = ["merit", "promotion", "adjustment", "cola"] as const;

export const COMP_CYCLE_STATUSES = [
  "draft",
  "open",
  "in_review",
  "approved",
  "pushed",
  "closed",
  "cancelled",
] as const;

export const COMP_CYCLE_LINE_STATUSES = ["pending", "proposed", "approved", "rejected", "pushed"] as const;

export const COMP_EVENT_KINDS = [
  "opened",
  "proposed",
  "reopened",
  "approved",
  "rejected",
  "budget_changed",
  "pushed",
  "closed",
  "cancelled",
] as const;

export const HEADCOUNT_PLAN_STATUSES = ["draft", "submitted", "approved", "closed"] as const;

export const HEADCOUNT_PLAN_LINE_KINDS = ["create", "backfill", "change", "terminate"] as const;

export const HEADCOUNT_PLAN_LINE_STATUSES = [
  "proposed",
  "approved",
  "rejected",
  "opened",
  "filled",
  "cancelled",
] as const;

export const PAY_INFORMATION_REQUEST_STATUSES = ["open", "fulfilled", "refused"] as const;

/** Stable craft identity per org code (e.g. 'ENG'). */
export const jobFamilies = pgTable(
  "hrm_job_families",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    foreignKey({ name: "hrm_job_families_org_id_fkey", columns: [t.orgId], foreignColumns: [orgs.id] }),
    uniqueIndex("hrm_job_families_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_job_families_code_per_org").on(t.orgId, t.code),
    check("hrm_job_families_code_not_blank", sql`char_length(btrim(${t.code})) > 0`),
    check("hrm_job_families_name_not_blank", sql`char_length(btrim(${t.name})) > 0`),
  ],
);

/** One rung per ladder per org code; NULL family = the org-wide ladder. */
export const jobLevels = pgTable(
  "hrm_job_levels",
  {
    id: id(),
    orgId: orgRef(),
    familyId: uuid("family_id"),
    code: text("code").notNull(),
    name: text("name").notNull(),
    rank: integer("rank").notNull(),
    equalValueCriteria: jsonb("equal_value_criteria").notNull().default([]),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    foreignKey({ name: "hrm_job_levels_org_id_fkey", columns: [t.orgId], foreignColumns: [orgs.id] }),
    foreignKey({
      name: "hrm_job_levels_family_tenant_fkey",
      columns: [t.orgId, t.familyId],
      foreignColumns: [jobFamilies.orgId, jobFamilies.id],
    }),
    uniqueIndex("hrm_job_levels_org_id_id_unique").on(t.orgId, t.id),
    check("hrm_job_levels_code_not_blank", sql`char_length(btrim(${t.code})) > 0`),
    check("hrm_job_levels_rank_positive", sql`${t.rank} >= 1`),
  ],
);

/** Versioned SHOULD-pay rows: a band change is a new row, never an overwrite. */
export const payBands = pgTable(
  "hrm_pay_bands",
  {
    id: id(),
    orgId: orgRef(),
    familyId: uuid("family_id"),
    levelId: uuid("level_id").notNull(),
    employerSubsidiaryId: uuid("employer_subsidiary_id"),
    locationId: uuid("location_id"),
    currency: text("currency").notNull(),
    basis: text("basis").notNull(),
    min: numeric("min", { precision: 19, scale: 4 }).notNull(),
    target: numeric("target", { precision: 19, scale: 4 }).notNull(),
    max: numeric("max", { precision: 19, scale: 4 }).notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    supersededBy: uuid("superseded_by"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({ name: "hrm_pay_bands_org_id_fkey", columns: [t.orgId], foreignColumns: [orgs.id] }),
    foreignKey({
      name: "hrm_pay_bands_level_tenant_fkey",
      columns: [t.orgId, t.levelId],
      foreignColumns: [jobLevels.orgId, jobLevels.id],
    }),
    uniqueIndex("hrm_pay_bands_org_id_id_unique").on(t.orgId, t.id),
    check("hrm_pay_bands_basis", sql`${t.basis} in ('annual', 'hourly')`),
    check("hrm_pay_bands_ordered", sql`${t.min} <= ${t.target} and ${t.target} <= ${t.max}`),
  ],
);

/** One merit/promotion/adjustment/cola round; the approval is a Flows run. */
export const compCycles = pgTable(
  "hrm_comp_cycles",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("draft"),
    effectiveOn: date("effective_on").notNull(),
    budgetBasis: text("budget_basis").notNull().default("combined"),
    budgetTotal: numeric("budget_total", { precision: 19, scale: 4 }),
    currency: text("currency").notNull(),
    guidelineKind: text("guideline_kind").notNull().default("matrix"),
    guideline: jsonb("guideline").notNull().default({}),
    scope: jsonb("scope").notNull().default({}),
    revision: integer("revision").notNull().default(1),
    flowRunId: uuid("flow_run_id"),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    pushedAt: timestamp("pushed_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    foreignKey({ name: "hrm_comp_cycles_org_id_fkey", columns: [t.orgId], foreignColumns: [orgs.id] }),
    uniqueIndex("hrm_comp_cycles_org_id_id_unique").on(t.orgId, t.id),
    check(
      "hrm_comp_cycles_status",
      sql`${t.status} in ('draft', 'open', 'in_review', 'approved', 'pushed', 'closed', 'cancelled')`,
    ),
    check("hrm_comp_cycles_name_not_blank", sql`char_length(btrim(${t.name})) > 0`),
  ],
);

/** One envelope per cycle per department-or-manager holder (allocation computed at read). */
export const compCycleBudgets = pgTable(
  "hrm_comp_cycle_budgets",
  {
    id: id(),
    orgId: orgRef(),
    cycleId: uuid("cycle_id").notNull(),
    departmentId: uuid("department_id"),
    managerPartyId: uuid("manager_party_id"),
    currency: text("currency").notNull(),
    amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_comp_cycle_budgets_manager_party_tenant_fkey",
      columns: [t.orgId, t.managerPartyId],
      foreignColumns: [parties.orgId, parties.id],
    }),
    foreignKey({ name: "hrm_comp_cycle_budgets_org_id_fkey", columns: [t.orgId], foreignColumns: [orgs.id] }),
    foreignKey({
      name: "hrm_comp_cycle_budgets_cycle_tenant_fkey",
      columns: [t.orgId, t.cycleId],
      foreignColumns: [compCycles.orgId, compCycles.id],
    }),
    check("hrm_comp_cycle_budgets_one_holder", sql`num_nonnulls(${t.departmentId}, ${t.managerPartyId}) = 1`),
  ],
);

/** One decision per cycle per employment, snapshotted at open. */
export const compCycleLines = pgTable(
  "hrm_comp_cycle_lines",
  {
    id: id(),
    orgId: orgRef(),
    cycleId: uuid("cycle_id").notNull(),
    employmentId: uuid("employment_id").notNull(),
    currentRate: numeric("current_rate", { precision: 19, scale: 4 }).notNull(),
    currency: text("currency").notNull(),
    basis: text("basis").notNull(),
    bandId: uuid("band_id"),
    compaRatio: numeric("compa_ratio", { precision: 19, scale: 10 }),
    ratingKey: text("rating_key"),
    guidelineMinPct: numeric("guideline_min_pct", { precision: 19, scale: 6 }),
    guidelineMaxPct: numeric("guideline_max_pct", { precision: 19, scale: 6 }),
    proposedPct: numeric("proposed_pct", { precision: 19, scale: 6 }),
    proposedRate: numeric("proposed_rate", { precision: 19, scale: 4 }),
    proposedBy: uuid("proposed_by"),
    proposedAt: timestamp("proposed_at", { withTimezone: true }),
    status: text("status").notNull().default("pending"),
    approverPartyId: uuid("approver_party_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    reason: text("reason"),
    pushedRateId: uuid("pushed_rate_id"),
    revision: integer("revision").notNull().default(1),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_comp_cycle_lines_approver_party_tenant_fkey",
      columns: [t.orgId, t.approverPartyId],
      foreignColumns: [parties.orgId, parties.id],
    }),
    foreignKey({ name: "hrm_comp_cycle_lines_org_id_fkey", columns: [t.orgId], foreignColumns: [orgs.id] }),
    foreignKey({
      name: "hrm_comp_cycle_lines_cycle_tenant_fkey",
      columns: [t.orgId, t.cycleId],
      foreignColumns: [compCycles.orgId, compCycles.id],
    }),
    foreignKey({
      name: "hrm_comp_cycle_lines_employment_tenant_fkey",
      columns: [t.orgId, t.employmentId],
      foreignColumns: [workerEmployments.orgId, workerEmployments.id],
    }),
    uniqueIndex("hrm_comp_cycle_lines_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_comp_cycle_lines_one_per_employment").on(t.cycleId, t.employmentId),
    check(
      "hrm_comp_cycle_lines_status",
      sql`${t.status} in ('pending', 'proposed', 'approved', 'rejected', 'pushed')`,
    ),
  ],
);

/** Append-only cycle evidence. */
export const compEvents = pgTable(
  "hrm_comp_events",
  {
    id: id(),
    orgId: orgRef(),
    cycleId: uuid("cycle_id").notNull(),
    lineId: uuid("line_id"),
    kind: text("kind").notNull(),
    actor: uuid("actor"),
    reason: text("reason"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: "hrm_comp_events_org_id_fkey", columns: [t.orgId], foreignColumns: [orgs.id] }),
    foreignKey({
      name: "hrm_comp_events_cycle_tenant_fkey",
      columns: [t.orgId, t.cycleId],
      foreignColumns: [compCycles.orgId, compCycles.id],
    }),
  ],
);

/** Frozen per-employment total-rewards payloads. */
export const compStatements = pgTable(
  "hrm_comp_statements",
  {
    id: id(),
    orgId: orgRef(),
    employmentId: uuid("employment_id").notNull(),
    cycleId: uuid("cycle_id"),
    periodFrom: date("period_from").notNull(),
    periodTo: date("period_to").notNull(),
    payload: jsonb("payload").notNull(),
    fileId: uuid("file_id"),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    generatedBy: uuid("generated_by"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({ name: "hrm_comp_statements_org_id_fkey", columns: [t.orgId], foreignColumns: [orgs.id] }),
    foreignKey({
      name: "hrm_comp_statements_employment_tenant_fkey",
      columns: [t.orgId, t.employmentId],
      foreignColumns: [workerEmployments.orgId, workerEmployments.id],
    }),
    foreignKey({
      name: "hrm_comp_statements_file_tenant_fkey",
      columns: [t.orgId, t.fileId],
      foreignColumns: [files.orgId, files.id],
    }),
  ],
);

/** One workforce plan per fiscal window. */
export const headcountPlans = pgTable(
  "hrm_headcount_plans",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    fiscalPeriodFrom: date("fiscal_period_from").notNull(),
    fiscalPeriodTo: date("fiscal_period_to").notNull(),
    status: text("status").notNull().default("draft"),
    scope: jsonb("scope").notNull().default({}),
    revision: integer("revision").notNull().default(1),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    foreignKey({ name: "hrm_headcount_plans_org_id_fkey", columns: [t.orgId], foreignColumns: [orgs.id] }),
    uniqueIndex("hrm_headcount_plans_org_id_id_unique").on(t.orgId, t.id),
    check(
      "hrm_headcount_plans_status",
      sql`${t.status} in ('draft', 'submitted', 'approved', 'closed')`,
    ),
    check("hrm_headcount_plans_name_not_blank", sql`char_length(btrim(${t.name})) > 0`),
  ],
);

/** One planned movement per plan; terminate lines are informational only. */
export const headcountPlanLines = pgTable(
  "hrm_headcount_plan_lines",
  {
    id: id(),
    orgId: orgRef(),
    planId: uuid("plan_id").notNull(),
    kind: text("kind").notNull(),
    positionId: uuid("position_id"),
    title: text("title").notNull(),
    departmentId: uuid("department_id"),
    employerSubsidiaryId: uuid("employer_subsidiary_id").notNull(),
    jobLevelId: uuid("job_level_id"),
    plannedFte: numeric("planned_fte", { precision: 7, scale: 4 }).notNull(),
    startOn: date("start_on").notNull(),
    endOn: date("end_on"),
    estAnnualCost: numeric("est_annual_cost", { precision: 19, scale: 4 }).notNull(),
    currency: text("currency").notNull(),
    costBasis: jsonb("cost_basis").notNull(),
    status: text("status").notNull().default("proposed"),
    requisitionId: uuid("requisition_id"),
    reason: text("reason"),
    revision: integer("revision").notNull().default(1),
    ...auditColumns,
  },
  (t) => [
    foreignKey({ name: "hrm_headcount_plan_lines_org_id_fkey", columns: [t.orgId], foreignColumns: [orgs.id] }),
    foreignKey({
      name: "hrm_headcount_plan_lines_plan_tenant_fkey",
      columns: [t.orgId, t.planId],
      foreignColumns: [headcountPlans.orgId, headcountPlans.id],
    }),
    foreignKey({
      name: "hrm_headcount_plan_lines_position_tenant_fkey",
      columns: [t.orgId, t.positionId],
      foreignColumns: [positions.orgId, positions.id],
    }),
    foreignKey({
      name: "hrm_headcount_plan_lines_employer_tenant_fkey",
      columns: [t.orgId, t.employerSubsidiaryId],
      foreignColumns: [subsidiaries.orgId, subsidiaries.id],
    }),
    foreignKey({
      name: "hrm_headcount_plan_lines_department_tenant_fkey",
      columns: [t.orgId, t.departmentId],
      foreignColumns: [departments.orgId, departments.id],
    }),
    foreignKey({
      name: "hrm_headcount_plan_lines_level_tenant_fkey",
      columns: [t.orgId, t.jobLevelId],
      foreignColumns: [jobLevels.orgId, jobLevels.id],
    }),
    uniqueIndex("hrm_headcount_plan_lines_org_id_id_unique").on(t.orgId, t.id),
    check(
      "hrm_headcount_plan_lines_kind",
      sql`${t.kind} in ('create', 'backfill', 'change', 'terminate')`,
    ),
    check(
      "hrm_headcount_plan_lines_status",
      sql`${t.status} in ('proposed', 'approved', 'rejected', 'opened', 'filled', 'cancelled')`,
    ),
  ],
);

/** Frozen Article 9 metrics computed from payroll truth. */
export const payGapSnapshots = pgTable(
  "hrm_pay_gap_snapshots",
  {
    id: id(),
    orgId: orgRef(),
    asOf: date("as_of").notNull(),
    scope: jsonb("scope").notNull().default({}),
    metrics: jsonb("metrics").notNull(),
    categories: jsonb("categories").notNull(),
    generatedBy: uuid("generated_by"),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns,
  },
  (t) => [
    foreignKey({ name: "hrm_pay_gap_snapshots_org_id_fkey", columns: [t.orgId], foreignColumns: [orgs.id] }),
    uniqueIndex("hrm_pay_gap_snapshots_org_id_id_unique").on(t.orgId, t.id),
  ],
);

/** Worker requests for their category averages. */
export const payInformationRequests = pgTable(
  "hrm_pay_information_requests",
  {
    id: id(),
    orgId: orgRef(),
    employmentId: uuid("employment_id").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
    responseSnapshotId: uuid("response_snapshot_id"),
    status: text("status").notNull().default("open"),
    reason: text("reason"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({ name: "hrm_pay_information_requests_org_id_fkey", columns: [t.orgId], foreignColumns: [orgs.id] }),
    foreignKey({
      name: "hrm_pay_information_requests_employment_tenant_fkey",
      columns: [t.orgId, t.employmentId],
      foreignColumns: [workerEmployments.orgId, workerEmployments.id],
    }),
    foreignKey({
      name: "hrm_pay_information_requests_snapshot_tenant_fkey",
      columns: [t.orgId, t.responseSnapshotId],
      foreignColumns: [payGapSnapshots.orgId, payGapSnapshots.id],
    }),
    check(
      "hrm_pay_information_requests_status",
      sql`${t.status} in ('open', 'fulfilled', 'refused')`,
    ),
  ],
);

