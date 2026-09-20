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

/**
 * HRM construction compliance (migrations 0223/0224) — drizzle mirror of
 * the published SQL. Country-agnostic: jurisdiction codes, match shapes
 * and format keys are org-declared or pack-declared free text/shapes;
 * the generic layer branches on nothing.
 */

export const HRM_RATE_SCHEDULE_KINDS = ["prevailing_wage", "union_agreement", "org_declared"] as const;

export const HRM_RATE_SCHEDULE_RECIPROCITY = ["home_local", "jobsite_local", "higher_of"] as const;

export const HRM_PER_DIEM_BASES = ["flat_daily", "distance_brackets", "hours_threshold"] as const;

export const HRM_PER_DIEM_ENTRY_STATUSES = ["computed", "approved", "voided", "consumed"] as const;

export const HRM_ALLOWANCE_ENTRY_KINDS = ["per_diem", "travel"] as const;

export const HRM_ALLOWANCE_INPUT_STATUSES = ["pending", "consumed", "voided"] as const;

export const HRM_CERTIFIED_RUN_STATUSES = ["draft", "generated", "submitted", "amended"] as const;

export const HRM_COMPLIANCE_FINDING_KINDS = [
  "ratio_breach",
  "missing_rate",
  "class_unresolved",
  "registration_missing",
  "fringe_mismatch",
] as const;

export const HRM_COMPLIANCE_FINDING_STATUSES = ["open", "acknowledged", "resolved"] as const;

/** Work classifications (0223): the org's trade taxonomy. */
export const hrmWorkClassifications = pgTable(
  "hrm_work_classifications",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    trade: text("trade").notNull(),
    isApprentice: boolean("is_apprentice").notNull().default(false),
    apprenticeProgramRef: text("apprentice_program_ref"),
    journeyClassificationId: uuid("journey_classification_id"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_work_classifications_journey_fkey",
      columns: [t.orgId, t.journeyClassificationId],
      foreignColumns: [t.orgId, t.id],
    }),
    uniqueIndex("hrm_work_classifications_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_work_classifications_org_code_unique").on(t.orgId, t.code),
    check("hrm_work_classifications_code", sql`char_length(btrim(${t.code})) > 0`),
    check("hrm_work_classifications_name", sql`char_length(btrim(${t.name})) > 0`),
    check("hrm_work_classifications_trade", sql`char_length(btrim(${t.trade})) > 0`),
  ],
);

/** Rate schedules (0223): prevailing-wage, union-agreement, org-declared. */
export const hrmRateSchedules = pgTable(
  "hrm_rate_schedules",
  {
    id: id(),
    orgId: orgRef(),
    kind: text("kind", { enum: HRM_RATE_SCHEDULE_KINDS }).notNull(),
    name: text("name").notNull(),
    sourceRef: text("source_ref"),
    jurisdictionCode: text("jurisdiction_code"),
    appliesTo: jsonb("applies_to").notNull().default({}),
    reciprocity: text("reciprocity", { enum: HRM_RATE_SCHEDULE_RECIPROCITY }).notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("hrm_rate_schedules_org_id_id_unique").on(t.orgId, t.id),
    index("hrm_rate_schedules_org_active").on(t.orgId, t.isActive),
    check("hrm_rate_schedules_name", sql`char_length(btrim(${t.name})) > 0`),
    check(
      "hrm_rate_schedules_window",
      sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
  ],
);

/** Rate schedule lines (0223): one resolvable rate per schedule/classification/date. */
export const hrmRateScheduleLines = pgTable(
  "hrm_rate_schedule_lines",
  {
    id: id(),
    orgId: orgRef(),
    scheduleId: uuid("schedule_id").notNull(),
    classificationId: uuid("classification_id").notNull(),
    baseRate: numeric("base_rate", { precision: 19, scale: 4 }).notNull(),
    fringeRate: numeric("fringe_rate", { precision: 19, scale: 4 }).notNull().default("0"),
    fringeCreditRate: numeric("fringe_credit_rate", { precision: 19, scale: 4 }).notNull().default("0"),
    overtimeMultiplier: numeric("overtime_multiplier", { precision: 19, scale: 4 }).notNull().default("1.5"),
    currency: text("currency").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_rate_schedule_lines_schedule_fkey",
      columns: [t.orgId, t.scheduleId],
      foreignColumns: [hrmRateSchedules.orgId, hrmRateSchedules.id],
    }),
    foreignKey({
      name: "hrm_rate_schedule_lines_classification_fkey",
      columns: [t.orgId, t.classificationId],
      foreignColumns: [hrmWorkClassifications.orgId, hrmWorkClassifications.id],
    }),
    uniqueIndex("hrm_rate_schedule_lines_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_rate_schedule_lines_version_unique").on(t.scheduleId, t.classificationId, t.effectiveFrom),
    check(
      "hrm_rate_schedule_lines_window",
      sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
  ],
);

/** Employment classifications (0223): bitemporal assignments with history. */
export const hrmEmploymentClassifications = pgTable(
  "hrm_employment_classifications",
  {
    id: id(),
    orgId: orgRef(),
    employmentId: uuid("employment_id").notNull(),
    classificationId: uuid("classification_id").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    homeScheduleId: uuid("home_schedule_id"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_employment_classifications_classification_fkey",
      columns: [t.orgId, t.classificationId],
      foreignColumns: [hrmWorkClassifications.orgId, hrmWorkClassifications.id],
    }),
    foreignKey({
      name: "hrm_employment_classifications_home_schedule_fkey",
      columns: [t.orgId, t.homeScheduleId],
      foreignColumns: [hrmRateSchedules.orgId, hrmRateSchedules.id],
    }),
    uniqueIndex("hrm_employment_classifications_org_id_id_unique").on(t.orgId, t.id),
    index("hrm_employment_classifications_employment_asof").on(t.orgId, t.employmentId, t.effectiveFrom),
    check(
      "hrm_employment_classifications_window",
      sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
  ],
);

/** Per-diem policies (0223): org-declared computation rules per basis. */
export const hrmPerDiemPolicies = pgTable(
  "hrm_per_diem_policies",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    basis: text("basis", { enum: HRM_PER_DIEM_BASES }).notNull(),
    rules: jsonb("rules").notNull(),
    lodgingOffset: numeric("lodging_offset", { precision: 19, scale: 4 }),
    weeklyRule: jsonb("weekly_rule"),
    payComponentId: uuid("pay_component_id"),
    currency: text("currency").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    appliesTo: jsonb("applies_to").notNull().default({}),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("hrm_per_diem_policies_org_id_id_unique").on(t.orgId, t.id),
    check("hrm_per_diem_policies_name", sql`char_length(btrim(${t.name})) > 0`),
    check(
      "hrm_per_diem_policies_window",
      sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
  ],
);

/** Per-diem entries (0223): one computed row per employment per project per day. */
export const hrmPerDiemEntries = pgTable(
  "hrm_per_diem_entries",
  {
    id: id(),
    orgId: orgRef(),
    employmentId: uuid("employment_id").notNull(),
    projectId: uuid("project_id"),
    workedOn: date("worked_on").notNull(),
    policyId: uuid("policy_id").notNull(),
    amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
    currency: text("currency").notNull(),
    basisInputs: jsonb("basis_inputs").notNull().default({}),
    status: text("status", { enum: HRM_PER_DIEM_ENTRY_STATUSES }).notNull().default("computed"),
    consumedByRunDocumentId: uuid("consumed_by_run_document_id"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_per_diem_entries_policy_fkey",
      columns: [t.orgId, t.policyId],
      foreignColumns: [hrmPerDiemPolicies.orgId, hrmPerDiemPolicies.id],
    }),
    uniqueIndex("hrm_per_diem_entries_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_per_diem_entries_day_unique").on(t.orgId, t.employmentId, t.projectId, t.workedOn),
  ],
);

/** Travel-pay entries (0223): same shape, separate table so voids never cross. */
export const hrmTravelPayEntries = pgTable(
  "hrm_travel_pay_entries",
  {
    id: id(),
    orgId: orgRef(),
    employmentId: uuid("employment_id").notNull(),
    projectId: uuid("project_id"),
    workedOn: date("worked_on").notNull(),
    policyId: uuid("policy_id").notNull(),
    amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
    currency: text("currency").notNull(),
    basisInputs: jsonb("basis_inputs").notNull().default({}),
    status: text("status", { enum: HRM_PER_DIEM_ENTRY_STATUSES }).notNull().default("computed"),
    consumedByRunDocumentId: uuid("consumed_by_run_document_id"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_travel_pay_entries_policy_fkey",
      columns: [t.orgId, t.policyId],
      foreignColumns: [hrmPerDiemPolicies.orgId, hrmPerDiemPolicies.id],
    }),
    uniqueIndex("hrm_travel_pay_entries_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_travel_pay_entries_day_unique").on(t.orgId, t.employmentId, t.projectId, t.workedOn),
  ],
);

/** Allowance payroll-input seam (0223): one row per per-diem/travel entry. */
export const hrmAllowancePayrollInputs = pgTable(
  "hrm_allowance_payroll_inputs",
  {
    id: id(),
    orgId: orgRef(),
    entryKind: text("entry_kind", { enum: HRM_ALLOWANCE_ENTRY_KINDS }).notNull(),
    entryId: uuid("entry_id").notNull(),
    employmentId: uuid("employment_id").notNull(),
    employeePartyId: uuid("employee_party_id").notNull(),
    payComponentId: uuid("pay_component_id").notNull(),
    amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
    currency: text("currency").notNull(),
    coverageDate: date("coverage_date").notNull(),
    status: text("status", { enum: HRM_ALLOWANCE_INPUT_STATUSES }).notNull().default("pending"),
    consumedByRunDocumentId: uuid("consumed_by_run_document_id"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_allowance_payroll_inputs_party_tenant_fkey",
      columns: [t.orgId, t.employeePartyId],
      foreignColumns: [parties.orgId, parties.id],
    }),
    uniqueIndex("hrm_allowance_payroll_inputs_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_allowance_payroll_inputs_entry_unique").on(t.orgId, t.entryKind, t.entryId),
    index("hrm_allowance_payroll_inputs_run_read").on(t.orgId, t.employeePartyId, t.coverageDate, t.status),
    check("hrm_allowance_payroll_inputs_amount", sql`${t.amount} > 0`),
  ],
);

/** Comp classes (0224): workers'-comp / premium class taxonomy. */
export const hrmCompClasses = pgTable(
  "hrm_comp_classes",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    jurisdictionCode: text("jurisdiction_code"),
    ratePer100: numeric("rate_per_100", { precision: 19, scale: 4 }),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("hrm_comp_classes_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_comp_classes_org_code_unique").on(t.orgId, t.code),
    check("hrm_comp_classes_code", sql`char_length(btrim(${t.code})) > 0`),
    check("hrm_comp_classes_name", sql`char_length(btrim(${t.name})) > 0`),
    check(
      "hrm_comp_classes_window",
      sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
  ],
);

/** Comp-class match rules (0224): priority-ordered, closed match shape. */
export const hrmCompClassRules = pgTable(
  "hrm_comp_class_rules",
  {
    id: id(),
    orgId: orgRef(),
    priority: integer("priority").notNull(),
    match: jsonb("match").notNull(),
    compClassId: uuid("comp_class_id").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_comp_class_rules_class_fkey",
      columns: [t.orgId, t.compClassId],
      foreignColumns: [hrmCompClasses.orgId, hrmCompClasses.id],
    }),
    uniqueIndex("hrm_comp_class_rules_org_id_id_unique").on(t.orgId, t.id),
    index("hrm_comp_class_rules_org_priority").on(t.orgId, t.priority),
    check("hrm_comp_class_rules_priority", sql`${t.priority} >= 0`),
  ],
);

/** Certified payroll runs (0224): frozen payload plus the rendered pack artefact. */
export const hrmCertifiedPayrollRuns = pgTable(
  "hrm_certified_payroll_runs",
  {
    id: id(),
    orgId: orgRef(),
    projectId: uuid("project_id"),
    weekEnding: date("week_ending").notNull(),
    scheduleId: uuid("schedule_id"),
    status: text("status", { enum: HRM_CERTIFIED_RUN_STATUSES }).notNull().default("draft"),
    payrollRunDocumentIds: jsonb("payroll_run_document_ids").notNull().default([]),
    payload: jsonb("payload").notNull().default({ rows: [] }),
    formatKey: text("format_key").notNull(),
    fileId: uuid("file_id"),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    amendsRunId: uuid("amends_run_id"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("hrm_certified_payroll_runs_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_certified_payroll_runs_week_unique").on(
      t.orgId,
      t.projectId,
      t.weekEnding,
      t.formatKey,
      t.amendsRunId,
    ),
    check("hrm_certified_payroll_runs_format", sql`char_length(btrim(${t.formatKey})) > 0`),
  ],
);

/** Apprentice ratio rules (0224): journey:apprentice per schedule. */
export const hrmApprenticeRatioRules = pgTable(
  "hrm_apprentice_ratio_rules",
  {
    id: id(),
    orgId: orgRef(),
    scheduleId: uuid("schedule_id").notNull(),
    journeyClassificationId: uuid("journey_classification_id").notNull(),
    apprenticeClassificationId: uuid("apprentice_classification_id").notNull(),
    ratioJourney: integer("ratio_journey").notNull(),
    ratioApprentice: integer("ratio_apprentice").notNull(),
    measured: text("measured").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_apprentice_ratio_rules_schedule_fkey",
      columns: [t.orgId, t.scheduleId],
      foreignColumns: [hrmRateSchedules.orgId, hrmRateSchedules.id],
    }),
    foreignKey({
      name: "hrm_apprentice_ratio_rules_journey_fkey",
      columns: [t.orgId, t.journeyClassificationId],
      foreignColumns: [hrmWorkClassifications.orgId, hrmWorkClassifications.id],
    }),
    foreignKey({
      name: "hrm_apprentice_ratio_rules_apprentice_fkey",
      columns: [t.orgId, t.apprenticeClassificationId],
      foreignColumns: [hrmWorkClassifications.orgId, hrmWorkClassifications.id],
    }),
    uniqueIndex("hrm_apprentice_ratio_rules_org_id_id_unique").on(t.orgId, t.id),
    check("hrm_apprentice_ratio_rules_ratio", sql`${t.ratioJourney} > 0 and ${t.ratioApprentice} > 0`),
    check(
      "hrm_apprentice_ratio_rules_window",
      sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
  ],
);

/** Compliance findings (0224): append-only pre-run flags. */
export const hrmComplianceFindings = pgTable(
  "hrm_compliance_findings",
  {
    id: id(),
    orgId: orgRef(),
    kind: text("kind", { enum: HRM_COMPLIANCE_FINDING_KINDS }).notNull(),
    projectId: uuid("project_id"),
    workedOn: date("worked_on"),
    employmentId: uuid("employment_id"),
    detail: jsonb("detail").notNull().default({}),
    status: text("status", { enum: HRM_COMPLIANCE_FINDING_STATUSES }).notNull().default("open"),
    resolvedReason: text("resolved_reason"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("hrm_compliance_findings_org_id_id_unique").on(t.orgId, t.id),
    index("hrm_compliance_findings_org_status").on(t.orgId, t.status),
    index("hrm_compliance_findings_org_project_day").on(t.orgId, t.projectId, t.workedOn),
  ],
);
