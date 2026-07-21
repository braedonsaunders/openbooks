import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, currencyCode, fxRate, id, money, orgRef } from "./helpers";

/** Tenant-defined labor roles used for planning, costing, billing, and
 * resource pricing. A role is intentionally separate from an employee and a
 * service item: one person may perform several roles on different jobs. */
export const laborClasses = pgTable(
  "labor_classes",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    parentId: uuid("parent_id"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("labor_classes_org_code").on(t.orgId, t.code),
    index("labor_classes_parent").on(t.orgId, t.parentId),
  ],
);

/** Effective-dated employee-to-role history. This preserves the role that was
 * true on the work date instead of rewriting old time when a person is
 * promoted or transferred. */
export const employeeLaborClassAssignments = pgTable(
  "employee_labor_class_assignments",
  {
    id: id(),
    orgId: orgRef(),
    employeePartyId: uuid("employee_party_id").notNull(),
    laborClassId: uuid("labor_class_id").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    isPrimary: boolean("is_primary").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    index("employee_labor_class_employee_date").on(t.orgId, t.employeePartyId, t.effectiveFrom, t.effectiveTo),
    uniqueIndex("employee_labor_class_from").on(t.employeePartyId, t.laborClassId, t.effectiveFrom),
    check("employee_labor_class_valid_range", sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`),
  ],
);

/** Confidential employee standard-cost history. Payroll actuals remain a
 * separate truth and reconcile against this immediate job-cost estimate. */
export const employeeCompensationRates = pgTable(
  "employee_compensation_rates",
  {
    id: id(),
    orgId: orgRef(),
    employeePartyId: uuid("employee_party_id").notNull(),
    amount: money("amount").notNull(),
    currency: currencyCode("currency").notNull(),
    basis: text("basis", { enum: ["hour", "year"] }).notNull().default("hour"),
    annualHours: money("annual_hours").notNull().default("2080"),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    index("employee_compensation_employee_date").on(t.orgId, t.employeePartyId, t.effectiveFrom, t.effectiveTo),
    uniqueIndex("employee_compensation_from").on(t.employeePartyId, t.effectiveFrom),
    check("employee_compensation_nonnegative", sql`${t.amount} >= 0`),
    check("employee_compensation_annual_hours", sql`${t.annualHours} > 0`),
    check("employee_compensation_valid_range", sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`),
  ],
);

/** A dimensioned rate line inside an item-rate-book version. Nullable
 * dimensions are wildcards; activation rejects ambiguous equal-specificity
 * lines. Commercial scope belongs to the rate-book assignment, while these
 * columns describe the resource and work performed. */
export const laborRateLines = pgTable(
  "labor_rate_lines",
  {
    id: id(),
    orgId: orgRef(),
    versionId: uuid("version_id").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    lane: text("lane", {
      enum: ["direct_cost", "bill", "transfer", "planning_cost", "planning_bill"],
    }).notNull(),
    method: text("method", {
      enum: ["fixed", "at_cost", "markup_on_cost", "margin_on_cost"],
    }).notNull().default("fixed"),
    amount: money("amount"),
    percent: money("percent"),
    currency: currencyCode("currency").notNull(),
    unitCode: text("unit_code").notNull().default("hour"),
    baseHours: money("base_hours").notNull().default("1"),
    employeePartyId: uuid("employee_party_id"),
    laborClassId: uuid("labor_class_id"),
    itemId: uuid("item_id"),
    timeTypeId: uuid("time_type_id"),
    subsidiaryId: uuid("subsidiary_id"),
    departmentId: uuid("department_id"),
    locationId: uuid("location_id"),
    workerCompGroupId: uuid("worker_comp_group_id"),
    priority: integer("priority").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("labor_rate_lines_version_code").on(t.versionId, t.code),
    index("labor_rate_lines_match").on(t.orgId, t.versionId, t.lane, t.itemId, t.timeTypeId),
    check("labor_rate_lines_base_hours", sql`${t.baseHours} > 0`),
    check("labor_rate_lines_amount", sql`${t.amount} is null or ${t.amount} >= 0`),
    check("labor_rate_lines_percent", sql`${t.percent} is null or ${t.percent} >= 0`),
    check("labor_rate_lines_method_value", sql`
      (${t.method} = 'fixed' and ${t.amount} is not null and ${t.percent} is null)
      or (${t.method} = 'at_cost' and ${t.amount} is null and ${t.percent} is null)
      or (${t.method} = 'markup_on_cost' and ${t.amount} is null and ${t.percent} is not null)
      or (${t.method} = 'margin_on_cost' and ${t.amount} is null and ${t.percent} is not null and ${t.percent} < 100)
    `),
  ],
);

/** Ordered, explainable rate-stack components. Components are additions to a
 * lane; their basis makes overtime, statutory burdens, benefits, and overhead
 * behavior explicit instead of hiding it inside one hourly number. */
export const laborRateComponents = pgTable(
  "labor_rate_components",
  {
    id: id(),
    orgId: orgRef(),
    versionId: uuid("version_id").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    lane: text("lane", { enum: ["cost", "bill", "transfer"] }).notNull().default("cost"),
    method: text("method", {
      enum: ["fixed_per_hour", "percent_of_base_direct", "percent_of_direct", "percent_of_subtotal"],
    }).notNull(),
    value: money("value").notNull(),
    currency: currencyCode("currency"),
    employeePartyId: uuid("employee_party_id"),
    laborClassId: uuid("labor_class_id"),
    itemId: uuid("item_id"),
    timeTypeId: uuid("time_type_id"),
    subsidiaryId: uuid("subsidiary_id"),
    departmentId: uuid("department_id"),
    locationId: uuid("location_id"),
    workerCompGroupId: uuid("worker_comp_group_id"),
    sequence: integer("sequence").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("labor_rate_components_version_code").on(t.versionId, t.code),
    index("labor_rate_components_match").on(t.orgId, t.versionId, t.lane, t.sequence),
    check("labor_rate_components_nonnegative", sql`${t.value} >= 0`),
    check("labor_rate_components_currency", sql`${t.method} <> 'fixed_per_hour' or ${t.currency} is not null`),
  ],
);

/** Immutable rate explanation captured when time is approved. */
export const timeEntryRateComponents = pgTable(
  "time_entry_rate_components",
  {
    id: id(),
    orgId: orgRef(),
    timeEntryId: uuid("time_entry_id").notNull(),
    lane: text("lane", { enum: ["direct_cost", "burden", "bill", "transfer"] }).notNull(),
    sourceLineId: uuid("source_line_id"),
    sourceComponentId: uuid("source_component_id"),
    code: text("code").notNull(),
    name: text("name").notNull(),
    method: text("method").notNull(),
    sourceCurrency: currencyCode("source_currency").notNull(),
    fxRate: fxRate("fx_rate").notNull().default("1"),
    ratePerHour: money("rate_per_hour").notNull(),
    amount: money("amount").notNull(),
    sequence: integer("sequence").notNull(),
    explanation: text("explanation").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
  },
  (t) => [
    uniqueIndex("time_entry_rate_components_sequence").on(t.timeEntryId, t.lane, t.sequence),
    index("time_entry_rate_components_entry").on(t.orgId, t.timeEntryId),
  ],
);

/** Vendor-neutral source configuration for employer-cost detail calculated by
 * an external payroll system. OpenBooks does not calculate payroll; it imports
 * its accounting journal separately and uses these details for job costing. */
export const externalPayrollSources = pgTable(
  "external_payroll_sources",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    accountingMode: text("accounting_mode", {
      enum: ["costing_only", "variance_to_clearing"],
    }).notNull().default("variance_to_clearing"),
    payrollClearingAccountId: uuid("payroll_clearing_account_id"),
    requirePostedJournal: boolean("require_posted_journal").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [uniqueIndex("external_payroll_sources_org_code").on(t.orgId, t.code)],
);

/** Saved, tenant-owned column layouts for recurring external payroll files. */
export const externalPayrollImportTemplates = pgTable(
  "external_payroll_import_templates",
  {
    id: id(),
    orgId: orgRef(),
    sourceId: uuid("source_id").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    externalLineIdColumn: text("external_line_id_column").notNull().default("externalLineId"),
    employeeCodeColumn: text("employee_code_column").notNull().default("employeePartyId"),
    componentColumn: text("component_column").notNull().default("component"),
    amountColumn: text("amount_column").notNull().default("amount"),
    payCodeColumn: text("pay_code_column"),
    hoursColumn: text("hours_column"),
    memoColumn: text("memo_column"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("external_payroll_import_templates_source_code").on(t.sourceId, t.code),
    index("external_payroll_import_templates_org").on(t.orgId, t.sourceId),
  ],
);

/** External employer costs are imported as immutable batches, then distributed
 * across approved time. In variance mode the posting clears the difference
 * between the standard labor credit and the external payroll journal debit. */
export const payrollCostBatches = pgTable(
  "payroll_cost_batches",
  {
    id: id(),
    orgId: orgRef(),
    sourceId: uuid("source_id").notNull(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    code: text("code").notNull(),
    externalBatchId: text("external_batch_id").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    postingDate: date("posting_date").notNull(),
    currency: currencyCode("currency").notNull(),
    status: text("status", { enum: ["draft", "validated", "reconciled", "posted"] }).notNull().default("draft"),
    actualTotal: money("actual_total").notNull().default("0"),
    actualTotalBase: money("actual_total_base").notNull().default("0"),
    varianceTotal: money("variance_total").notNull().default("0"),
    sourceJournalDocumentId: uuid("source_journal_document_id"),
    varianceJournalEntryId: uuid("variance_journal_entry_id"),
    exceptionCount: integer("exception_count").notNull().default(0),
    validationErrors: jsonb("validation_errors").$type<string[]>().notNull().default([]),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("payroll_cost_batches_org_code").on(t.orgId, t.code),
    uniqueIndex("payroll_cost_batches_source_external").on(t.sourceId, t.externalBatchId),
    check("payroll_cost_batches_range", sql`${t.periodEnd} >= ${t.periodStart}`),
  ],
);

export const payrollCostLines = pgTable(
  "payroll_cost_lines",
  {
    id: id(),
    orgId: orgRef(),
    batchId: uuid("batch_id").notNull(),
    externalLineId: text("external_line_id").notNull(),
    employeePartyId: uuid("employee_party_id").notNull(),
    payCode: text("pay_code"),
    component: text("component", { enum: ["gross_pay", "employer_tax", "benefit", "worker_comp", "other"] }).notNull(),
    hours: money("hours"),
    amount: money("amount").notNull(),
    memo: text("memo"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("payroll_cost_lines_batch_external").on(t.batchId, t.externalLineId),
    index("payroll_cost_lines_batch_employee").on(t.orgId, t.batchId, t.employeePartyId),
    check("payroll_cost_lines_hours_nonnegative", sql`${t.hours} is null or ${t.hours} >= 0`),
  ],
);

export const payrollTimeAllocations = pgTable(
  "payroll_time_allocations",
  {
    id: id(),
    orgId: orgRef(),
    payrollLineId: uuid("payroll_line_id").notNull(),
    timeEntryId: uuid("time_entry_id").notNull(),
    projectId: uuid("project_id"),
    projectTaskId: uuid("project_task_id"),
    departmentId: uuid("department_id"),
    locationId: uuid("location_id"),
    allocatedAmount: money("allocated_amount").notNull(),
    standardAmount: money("standard_amount").notNull(),
    varianceAmount: money("variance_amount").notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("payroll_time_allocations_line_time").on(t.payrollLineId, t.timeEntryId),
    index("payroll_time_allocations_project").on(t.orgId, t.projectId),
  ],
);

// Foreign keys are maintained in schema/migrations/referential-integrity.sql.
