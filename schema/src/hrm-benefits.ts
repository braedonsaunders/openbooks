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
import { auditColumns, id, orgRef } from "./helpers";
import { parties } from "./parties";

export const HRM_BENEFIT_COST_BASES = ["per_period", "per_month", "per_year", "percent_of_pay"] as const;

export const HRM_BENEFIT_PRORATION_BASES = ["full_month", "daily"] as const;

export const HRM_ENROLLMENT_WINDOW_KINDS = ["open_enrollment", "new_hire", "life_event"] as const;

export const HRM_ENROLLMENT_WINDOW_STATUSES = ["draft", "open", "closed"] as const;

export const HRM_ENROLLMENT_STATUSES = [
  "elected",
  "waived",
  "pending_approval",
  "active",
  "ended",
  "cancelled",
] as const;

export const HRM_DEPENDENT_RELATIONSHIPS = ["spouse", "partner", "child", "other"] as const;

export const HRM_BENEFIT_EVENT_KINDS = [
  "elected",
  "waived",
  "approved",
  "activated",
  "changed",
  "ended",
  "cancelled",
  "life_event",
] as const;

/** The only two movements a benefit month may raise as a pay-run input. */
export const HRM_BENEFIT_PAYROLL_INPUT_KINDS = ["benefit_deduction", "employer_contribution"] as const;

export const HRM_BENEFIT_PAYROLL_INPUT_STATUSES = ["pending", "consumed", "voided"] as const;

/**
 * HRM benefit plans (migration 0197). The org's offered plans with cost
 * bases, the REQUIRED proration rule (no default — a silent default would
 * guess what a partial month pays), and pay-component links. Tax treatment
 * lives on the pay component (pay_components.tax_treatment), never here.
 * Plan kind is org-declared free text; no pack declares plan kinds.
 * Tier pricing lives in hrmBenefitPlanLevels below — the single source of
 * truth, never a parallel jsonb (workforce entities may not expose raw
 * JSON; 0193 templates/steps precedent).
 */
export const hrmBenefitPlans = pgTable(
  "hrm_benefit_plans",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    providerPartyId: uuid("provider_party_id"),
    employerSubsidiaryId: uuid("employer_subsidiary_id"),
    currency: text("currency").notNull(),
    employeeCostBasis: text("employee_cost_basis", { enum: HRM_BENEFIT_COST_BASES }).notNull(),
    employeeCost: numeric("employee_cost", { precision: 19, scale: 4 }),
    employerCostBasis: text("employer_cost_basis", { enum: HRM_BENEFIT_COST_BASES }).notNull(),
    employerCost: numeric("employer_cost", { precision: 19, scale: 4 }),
    employeePayComponentId: uuid("employee_pay_component_id"),
    employerPayComponentId: uuid("employer_pay_component_id"),
    pretax: boolean("pretax").notNull().default(false),
    prorationBasis: text("proration_basis", { enum: HRM_BENEFIT_PRORATION_BASES }).notNull(),
    waitingPeriodDays: integer("waiting_period_days").notNull().default(0),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_benefit_plans_provider_tenant_fkey",
      columns: [t.orgId, t.providerPartyId],
      foreignColumns: [parties.orgId, parties.id],
    }),
    uniqueIndex("hrm_benefit_plans_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_benefit_plans_org_code_unique").on(t.orgId, t.code),
    check("hrm_benefit_plans_code", sql`char_length(btrim(${t.code})) > 0`),
    check("hrm_benefit_plans_name", sql`char_length(btrim(${t.name})) > 0`),
    check("hrm_benefit_plans_kind", sql`char_length(btrim(${t.kind})) > 0`),
    check("hrm_benefit_plans_waiting", sql`${t.waitingPeriodDays} >= 0`),
    check(
      "hrm_benefit_plans_window",
      sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
  ],
);

/**
 * HRM benefit pricing tiers (0197): one row per tier per plan. An election
 * names its tier by coverage_level_key; tier amounts are COPIED onto the
 * election at elect time, so repricing a tier never rewrites history.
 */
export const hrmBenefitPlanLevels = pgTable(
  "hrm_benefit_plan_levels",
  {
    id: id(),
    orgId: orgRef(),
    planId: uuid("plan_id").notNull(),
    levelKey: text("level_key").notNull(),
    label: text("label").notNull(),
    employeeCost: numeric("employee_cost", { precision: 19, scale: 4 }).notNull(),
    employerCost: numeric("employer_cost", { precision: 19, scale: 4 }).notNull(),
    position: integer("position").notNull(),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_benefit_plan_levels_plan_tenant_fkey",
      columns: [t.orgId, t.planId],
      foreignColumns: [hrmBenefitPlans.orgId, hrmBenefitPlans.id],
    }),
    uniqueIndex("hrm_benefit_plan_levels_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_benefit_plan_levels_org_plan_key_unique").on(t.orgId, t.planId, t.levelKey),
    uniqueIndex("hrm_benefit_plan_levels_org_plan_position_unique").on(
      t.orgId,
      t.planId,
      t.position,
    ),
    check("hrm_benefit_plan_levels_key", sql`char_length(btrim(${t.levelKey})) > 0`),
    check("hrm_benefit_plan_levels_label", sql`char_length(btrim(${t.label})) > 0`),
    check(
      "hrm_benefit_plan_levels_costs",
      sql`${t.employeeCost} >= 0 and ${t.employerCost} >= 0`,
    ),
    check("hrm_benefit_plan_levels_position", sql`${t.position} >= 0`),
  ],
);

/**
 * HRM enrollment windows (0197): open_enrollment, new_hire, or life_event,
 * with applies_to scoping and draft/open/closed lifecycle. Closing refuses
 * pending elections with a reasoned event each — never silently dropped
 * (service rule; storage carries the declaration).
 */
export const hrmEnrollmentWindows = pgTable(
  "hrm_enrollment_windows",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    kind: text("kind", { enum: HRM_ENROLLMENT_WINDOW_KINDS }).notNull(),
    opensOn: date("opens_on").notNull(),
    closesOn: date("closes_on").notNull(),
    planYearStartOn: date("plan_year_start_on").notNull(),
    appliesTo: jsonb("applies_to")
      .$type<{ employer_subsidiary_id: string | null; department_id: string | null }>()
      .notNull(),
    status: text("status", { enum: HRM_ENROLLMENT_WINDOW_STATUSES }).notNull().default("draft"),
    // Read-only slot projections of the scope jsonb for structured surfaces
    // (0193 pattern: readable for prefill, never written — the Setup write
    // path folds the drawer slots back into applies_to before buildRow).
    appliesEmployerSubsidiaryId: uuid("applies_employer_subsidiary_id").generatedAlwaysAs(
      sql`(applies_to ->> 'employer_subsidiary_id')::uuid`,
    ),
    appliesDepartmentId: uuid("applies_department_id").generatedAlwaysAs(
      sql`(applies_to ->> 'department_id')::uuid`,
    ),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("hrm_enrollment_windows_org_id_id_unique").on(t.orgId, t.id),
    check("hrm_enrollment_windows_name", sql`char_length(btrim(${t.name})) > 0`),
    check("hrm_enrollment_windows_dates", sql`${t.closesOn} >= ${t.opensOn}`),
  ],
);

/**
 * HRM benefit elections (0197). Amounts are computed from the plan basis at
 * election and STORED in plan currency: a later plan price change never
 * rewrites these. A change ends the active row and opens a new one from the
 * change date — never an in-place rewrite (service rule).
 */
export const hrmBenefitEnrollments = pgTable(
  "hrm_benefit_enrollments",
  {
    id: id(),
    orgId: orgRef(),
    employmentId: uuid("employment_id").notNull(),
    planId: uuid("plan_id").notNull(),
    windowId: uuid("window_id"),
    coverageLevelKey: text("coverage_level_key"),
    status: text("status", { enum: HRM_ENROLLMENT_STATUSES }).notNull().default("elected"),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    employeeAmountPerPeriod: numeric("employee_amount_per_period", { precision: 19, scale: 4 }),
    employerAmountPerPeriod: numeric("employer_amount_per_period", { precision: 19, scale: 4 }),
    currency: text("currency").notNull(),
    electedAt: timestamp("elected_at", { withTimezone: true }).notNull().defaultNow(),
    electedBy: uuid("elected_by"),
    endedReason: text("ended_reason"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_benefit_enrollments_plan_tenant_fkey",
      columns: [t.orgId, t.planId],
      foreignColumns: [hrmBenefitPlans.orgId, hrmBenefitPlans.id],
    }),
    foreignKey({
      name: "hrm_benefit_enrollments_window_tenant_fkey",
      columns: [t.orgId, t.windowId],
      foreignColumns: [hrmEnrollmentWindows.orgId, hrmEnrollmentWindows.id],
    }),
    uniqueIndex("hrm_benefit_enrollments_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_benefit_enrollments_employment_plan_from_unique").on(
      t.orgId,
      t.employmentId,
      t.planId,
      t.effectiveFrom,
    ),
    index("hrm_benefit_enrollments_employment").on(t.orgId, t.employmentId),
    index("hrm_benefit_enrollments_plan").on(t.orgId, t.planId),
    index("hrm_benefit_enrollments_status").on(t.orgId, t.status),
    check(
      "hrm_benefit_enrollments_window",
      sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
  ],
);

/**
 * HRM covered dependents (0197). display_name is PII: enrolled in sandbox
 * masking like parties.
 */
export const hrmBenefitDependents = pgTable(
  "hrm_benefit_dependents",
  {
    id: id(),
    orgId: orgRef(),
    employmentId: uuid("employment_id").notNull(),
    relationship: text("relationship", { enum: HRM_DEPENDENT_RELATIONSHIPS }).notNull(),
    displayName: text("display_name").notNull(),
    birthDate: date("birth_date"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("hrm_benefit_dependents_org_id_id_unique").on(t.orgId, t.id),
    index("hrm_benefit_dependents_employment").on(t.orgId, t.employmentId),
    check("hrm_benefit_dependents_name", sql`char_length(btrim(${t.displayName})) > 0`),
  ],
);

/** Election ↔ dependent links (0197). */
export const hrmEnrollmentDependents = pgTable(
  "hrm_enrollment_dependents",
  {
    id: id(),
    orgId: orgRef(),
    enrollmentId: uuid("enrollment_id").notNull(),
    dependentId: uuid("dependent_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
  },
  (t) => [
    foreignKey({
      name: "hrm_enrollment_dependents_enrollment_tenant_fkey",
      columns: [t.orgId, t.enrollmentId],
      foreignColumns: [hrmBenefitEnrollments.orgId, hrmBenefitEnrollments.id],
    }),
    foreignKey({
      name: "hrm_enrollment_dependents_dependent_tenant_fkey",
      columns: [t.orgId, t.dependentId],
      foreignColumns: [hrmBenefitDependents.orgId, hrmBenefitDependents.id],
    }),
    uniqueIndex("hrm_enrollment_dependents_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_enrollment_dependents_org_link_unique").on(
      t.orgId,
      t.enrollmentId,
      t.dependentId,
    ),
  ],
);

/**
 * HRM benefit election evidence (0197): append-only. Every lifecycle move
 * appends an event with reason and actor; corrections are new events, never
 * updates (storage guard in the migration).
 */
export const hrmBenefitEvents = pgTable(
  "hrm_benefit_events",
  {
    id: id(),
    orgId: orgRef(),
    enrollmentId: uuid("enrollment_id").notNull(),
    kind: text("kind", { enum: HRM_BENEFIT_EVENT_KINDS }).notNull(),
    reason: text("reason").notNull(),
    actor: uuid("actor"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_benefit_events_enrollment_tenant_fkey",
      columns: [t.orgId, t.enrollmentId],
      foreignColumns: [hrmBenefitEnrollments.orgId, hrmBenefitEnrollments.id],
    }),
    uniqueIndex("hrm_benefit_events_org_id_id_unique").on(t.orgId, t.id),
    index("hrm_benefit_events_enrollment").on(t.orgId, t.enrollmentId),
    check("hrm_benefit_events_reason", sql`char_length(btrim(${t.reason})) > 0`),
  ],
);

/**
 * HRM benefit pay-run input seam (0197): ONE ROW PER ENROLMENT PER COVERAGE
 * MONTH PER KIND. HR sends AMOUNTS (already prorated by the plan rule) —
 * payroll allocates months to pay periods and never recomputes.
 * pay_component_id names the component whose tax_treatment prices the row;
 * employee_party_id is the key the run reads (resolved by HR from the
 * employment at write time); employment_id is provenance only and the two
 * are never interchangeable.
 */
export const hrmBenefitPayrollInputs = pgTable(
  "hrm_benefit_payroll_inputs",
  {
    id: id(),
    orgId: orgRef(),
    enrollmentId: uuid("enrollment_id").notNull(),
    employeePartyId: uuid("employee_party_id").notNull(),
    employmentId: uuid("employment_id").notNull(),
    kind: text("kind", { enum: HRM_BENEFIT_PAYROLL_INPUT_KINDS }).notNull(),
    payComponentId: uuid("pay_component_id").notNull(),
    amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
    currency: text("currency").notNull(),
    coverageFrom: date("coverage_from").notNull(),
    coverageTo: date("coverage_to").notNull(),
    status: text("status", { enum: HRM_BENEFIT_PAYROLL_INPUT_STATUSES })
      .notNull()
      .default("pending"),
    consumedByRunDocumentId: uuid("consumed_by_run_document_id"),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_benefit_payroll_inputs_enrollment_tenant_fkey",
      columns: [t.orgId, t.enrollmentId],
      foreignColumns: [hrmBenefitEnrollments.orgId, hrmBenefitEnrollments.id],
    }),
    foreignKey({
      name: "hrm_benefit_payroll_inputs_party_tenant_fkey",
      columns: [t.orgId, t.employeePartyId],
      foreignColumns: [parties.orgId, parties.id],
    }),
    uniqueIndex("hrm_benefit_payroll_inputs_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_benefit_payroll_inputs_enrollment_kind_month_unique").on(
      t.orgId,
      t.enrollmentId,
      t.kind,
      t.coverageFrom,
    ),
    index("hrm_benefit_payroll_inputs_party_month").on(
      t.orgId,
      t.employeePartyId,
      t.coverageFrom,
    ),
    check("hrm_benefit_payroll_inputs_amount", sql`${t.amount} > 0`),
    check("hrm_benefit_payroll_inputs_coverage", sql`${t.coverageTo} >= ${t.coverageFrom}`),
  ],
);
