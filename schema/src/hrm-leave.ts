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

export const HRM_LEAVE_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "rejected",
  "withdrawn",
  "cancelled",
] as const;

/** The only two movements a leave day may raise as a pay-run input. */
export const HRM_LEAVE_VALUE_CROSSINGS = ["none", "payout", "bank_in"] as const;

/** Native Flows subject kind for leave requests. */
export const HRM_LEAVE_REQUEST_SUBJECT_KIND = "hrm_leave_request";

export const HRM_PAYROLL_INPUT_KINDS = ["payout", "bank_in"] as const;

export const HRM_PAYROLL_INPUT_STATUSES = ["pending", "consumed", "voided"] as const;

export const HRM_ABSENCE_SOURCES = ["request", "recorded"] as const;

/**
 * HRM leave-type taxonomy (migration 0194). Org-configurable and
 * country-agnostic; no pack declares leave types. value_crossing names which
 * of the two allowed pay-run input movements (payout, bank_in) this type
 * raises, if any. There is no taken movement kind.
 */
export const hrmLeaveTypes = pgTable(
  "hrm_leave_types",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    paid: boolean("paid").notNull().default(true),
    valueCrossing: text("value_crossing", { enum: HRM_LEAVE_VALUE_CROSSINGS })
      .notNull()
      .default("none"),
    requiresAttachment: boolean("requires_attachment").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("hrm_leave_types_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_leave_types_org_code_unique").on(t.orgId, t.code),
    check("hrm_leave_types_code", sql`char_length(btrim(${t.code})) > 0`),
    check("hrm_leave_types_name", sql`char_length(btrim(${t.name})) > 0`),
  ],
);

/**
 * HRM leave policies (0194): HR entitlement in TIME per type. applies_to
 * scopes by employer subsidiary and department (nullable = org-wide);
 * accrual_rule declares none | per_period | per_year | unlimited with hours
 * as decimal strings; carryover_rule declares the carryover shape. The rule
 * shapes mirror engine/src/hrm/leave-math.ts (AccrualRule, CarryoverRule);
 * the jsonb columns stay the source of truth.
 * Effective-dated so a rule change never reinterprets history. This is not
 * the payroll bank in VALUE; the two are never conflated.
 */
export const hrmLeavePolicies = pgTable(
  "hrm_leave_policies",
  {
    id: id(),
    orgId: orgRef(),
    leaveTypeId: uuid("leave_type_id").notNull(),
    appliesTo: jsonb("applies_to")
      .$type<{ employer_subsidiary_id: string | null; department_id: string | null }>()
      .notNull(),
    accrualRule: jsonb("accrual_rule")
      .$type<{
        kind: "none" | "per_period" | "per_year" | "unlimited";
        hours?: string;
        periods_per_year?: number;
      }>()
      .notNull(),
    carryoverRule: jsonb("carryover_rule")
      .$type<{
        kind: "none" | "carry_all" | "carry_up_to";
        hours?: string | null;
        expires_after_days?: number | null;
      }>()
      .notNull(),
    // Read-only slot projections of the three rule jsonb columns for
    // structured surfaces (0194 STORED GENERATED columns): readable for
    // prefill, never written — the Setup write path folds the drawer slots
    // back into the jsonb before buildRow.
    appliesEmployerSubsidiaryId: uuid("applies_employer_subsidiary_id").generatedAlwaysAs(
      sql`(applies_to ->> 'employer_subsidiary_id')::uuid`,
    ),
    appliesDepartmentId: uuid("applies_department_id").generatedAlwaysAs(
      sql`(applies_to ->> 'department_id')::uuid`,
    ),
    accrualKind: text("accrual_kind").generatedAlwaysAs(sql`(accrual_rule ->> 'kind')`),
    accrualHours: text("accrual_hours").generatedAlwaysAs(sql`(accrual_rule ->> 'hours')`),
    accrualPeriodsPerYear: integer("accrual_periods_per_year").generatedAlwaysAs(
      sql`(accrual_rule ->> 'periods_per_year')::integer`,
    ),
    carryoverKind: text("carryover_kind").generatedAlwaysAs(sql`(carryover_rule ->> 'kind')`),
    carryoverHours: text("carryover_hours").generatedAlwaysAs(sql`(carryover_rule ->> 'hours')`),
    carryoverExpiresAfterDays: integer("carryover_expires_after_days").generatedAlwaysAs(
      sql`(carryover_rule ->> 'expires_after_days')::integer`,
    ),
    minimumNoticeDays: integer("minimum_notice_days").notNull().default(0),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_leave_policies_type_tenant_fkey",
      columns: [t.orgId, t.leaveTypeId],
      foreignColumns: [hrmLeaveTypes.orgId, hrmLeaveTypes.id],
    }),
    uniqueIndex("hrm_leave_policies_org_id_id_unique").on(t.orgId, t.id),
    check("hrm_leave_policies_notice", sql`${t.minimumNoticeDays} >= 0`),
    check(
      "hrm_leave_policies_window",
      sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
  ],
);

/**
 * HRM leave requests (0194). Overlap exclusion for approved requests per
 * employment lives in the SQL migration (Drizzle has no exclusion
 * primitive); decision coherence (decided_* set exactly on approved /
 * rejected) likewise.
 */
export const hrmLeaveRequests = pgTable(
  "hrm_leave_requests",
  {
    id: id(),
    orgId: orgRef(),
    employmentId: uuid("employment_id").notNull(),
    leaveTypeId: uuid("leave_type_id").notNull(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on").notNull(),
    hours: numeric("hours", { precision: 9, scale: 2 }).notNull(),
    reason: text("reason"),
    status: text("status", { enum: HRM_LEAVE_STATUSES }).notNull().default("draft"),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionReason: text("decision_reason"),
    flowInstanceId: uuid("flow_instance_id"),
    attachmentId: uuid("attachment_id"),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_leave_requests_type_tenant_fkey",
      columns: [t.orgId, t.leaveTypeId],
      foreignColumns: [hrmLeaveTypes.orgId, hrmLeaveTypes.id],
    }),
    uniqueIndex("hrm_leave_requests_org_id_id_unique").on(t.orgId, t.id),
    index("hrm_leave_requests_employment").on(t.orgId, t.employmentId),
    check("hrm_leave_requests_range", sql`${t.endsOn} >= ${t.startsOn}`),
    check("hrm_leave_requests_hours", sql`${t.hours} > 0`),
  ],
);

/**
 * HRM immutable absence record per day (0194). Corrections are reversing
 * rows (negative hours via reversal_of), never updates.
 */
export const hrmAbsences = pgTable(
  "hrm_absences",
  {
    id: id(),
    orgId: orgRef(),
    leaveRequestId: uuid("leave_request_id"),
    employmentId: uuid("employment_id").notNull(),
    onDate: date("on_date").notNull(),
    hours: numeric("hours", { precision: 9, scale: 2 }).notNull(),
    leaveTypeId: uuid("leave_type_id").notNull(),
    source: text("source", { enum: HRM_ABSENCE_SOURCES }).notNull(),
    reversalOf: uuid("reversal_of"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("hrm_absences_org_id_id_unique").on(t.orgId, t.id),
    index("hrm_absences_employment_day").on(t.orgId, t.employmentId, t.onDate),
    check("hrm_absences_hours", sql`${t.hours} <> 0`),
  ],
);

/**
 * HRM pay-run input queue (0194): ONE ROW PER ABSENCE DAY for payout /
 * bank_in types. HR sends HOURS only — there is deliberately NO amount
 * column; the run resolves the rate. employee_party_id is the key the ledger
 * reads (resolved by HR from the employment at write time); employment_id is
 * provenance only and the two are never interchangeable.
 */
export const hrmPayrollInputs = pgTable(
  "hrm_payroll_inputs",
  {
    id: id(),
    orgId: orgRef(),
    employeePartyId: uuid("employee_party_id").notNull(),
    employmentId: uuid("employment_id").notNull(),
    kind: text("kind", { enum: HRM_PAYROLL_INPUT_KINDS }).notNull(),
    absenceDate: date("absence_date").notNull(),
    hours: numeric("hours", { precision: 9, scale: 2 }).notNull(),
    sourceLeaveRequestId: uuid("source_leave_request_id").notNull(),
    status: text("status", { enum: HRM_PAYROLL_INPUT_STATUSES }).notNull().default("pending"),
    consumedByRunDocumentId: uuid("consumed_by_run_document_id"),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "hrm_payroll_inputs_party_tenant_fkey",
      columns: [t.orgId, t.employeePartyId],
      foreignColumns: [parties.orgId, parties.id],
    }),
    uniqueIndex("hrm_payroll_inputs_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("hrm_payroll_inputs_source_day_unique").on(
      t.orgId,
      t.sourceLeaveRequestId,
      t.absenceDate,
    ),
    index("hrm_payroll_inputs_party_day").on(t.orgId, t.employeePartyId, t.absenceDate),
    check("hrm_payroll_inputs_hours", sql`${t.hours} > 0`),
  ],
);
