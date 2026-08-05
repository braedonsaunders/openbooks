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
import { auditColumns, currencyCode, id, money, orgRef } from "./helpers";

/**
 * Payroll module (feature `payroll`, off by default).
 *
 * Design doctrine:
 * - Wages have ONE home: labor_cost_rates (employee scope) — payroll resolves
 *   the same effective-dated wage the costing engine snapshots into time
 *   entries. No second wage table, ever (see the reverted 9ff64c18 prior art).
 * - Statutory amounts (CPP/CPP2/EI/QPIP/income tax) are computed by the
 *   versioned T4127 engine in engine/src/payroll/canada — they are never
 *   user-authored component formulas. User components cover everything else.
 * - A pay run is a posting `documents` kind ('pay_run') with this 1:1
 *   extension, so numbering, approval, posting, voiding, and period control
 *   ride the standard document machinery.
 * - YTD state = payroll_opening_balances (mid-year adoption) + posted stubs.
 *   Nothing else accumulates, so recalculating a stub is always safe.
 */

/** Pay frequency calendar: drives P (periods per year) and period boundaries. */
export const paySchedules = pgTable(
  "pay_schedules",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    frequency: text("frequency", {
      enum: ["weekly", "biweekly", "semi_monthly", "monthly"],
    }).notNull(),
    /** T4127 factor P: 52/53, 26/27, 24, 12. Explicit to support 53/27 years. */
    periodsPerYear: integer("periods_per_year").notNull(),
    /** End date of any one period; other periods derive from it. */
    anchorPeriodEnd: date("anchor_period_end").notNull(),
    /** Days from period end to the cheque/deposit date. */
    payDateOffsetDays: integer("pay_date_offset_days").notNull().default(0),
    /** Legal entity this calendar pays. Null = org-wide (root subsidiary).
     * Scoped schedules pin their runs' entity + currency and only include
     * employees belonging to that subsidiary — one org can run a Canadian
     * CAD schedule beside a US USD schedule this way. */
    subsidiaryId: uuid("subsidiary_id"),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("pay_schedules_org_name").on(t.orgId, t.name),
    index("pay_schedules_subsidiary").on(t.orgId, t.subsidiaryId),
    check("pay_schedules_periods", sql`${t.periodsPerYear} in (12, 24, 26, 27, 52, 53)`),
    check("pay_schedules_offset", sql`${t.payDateOffsetDays} >= 0 and ${t.payDateOffsetDays} <= 31`),
  ],
);

/**
 * Pay components — the earnings/deductions/employer-contribution atoms.
 * Statutory components carry a systemKey and are engine-computed; their rows
 * exist so tenants can map GL accounts and remittance vendors per component.
 */
export const payComponents = pgTable(
  "pay_components",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    kind: text("kind", {
      enum: ["earning", "deduction", "employer_contribution"],
    }).notNull(),
    /** Country pack the component belongs to; null = shared across packs.
     * Statutory rows get it from their seeder; user components may scope
     * themselves so they only apply to that country's employees. */
    country: text("country", { enum: ["CA", "US"] }),
    /**
     * Engine-computed statutory components; null for user components.
     * cpp/cpp2/ei/qpip (CA) and ss/medicare (US) pairs exist for both
     * employee and employer sides via kind; income_tax (CRA) and fit (IRS)
     * are single combined withholding components; futa/suta are
     * employer-only.
     */
    systemKey: text("system_key", {
      enum: [
        "base_pay", "overtime", "bonus", "vacation_accrual", "vacation_payout",
        "cpp", "cpp2", "ei", "qpip", "income_tax",
        "fit", "ss", "medicare", "medicare_addl", "futa", "suta",
      ],
    }),
    /** How a user component's amount is produced (statutory rows ignore this). */
    basis: text("basis", {
      enum: ["fixed_amount", "per_hour", "percent_of_gross"],
    }).notNull().default("fixed_amount"),
    /** Default amount / hourly rate / percent, overridable per employee. */
    value: money("value"),
    /** Earnings: statutory treatment of the amount. */
    taxable: boolean("taxable").notNull().default(true),
    pensionable: boolean("pensionable").notNull().default(true),
    insurable: boolean("insurable").notNull().default(true),
    /** Earnings: counts toward vacationable earnings. */
    vacationable: boolean("vacationable").notNull().default(true),
    /** Earnings: taxed with the T4127 bonus (non-periodic) method. */
    nonPeriodic: boolean("non_periodic").notNull().default(false),
    /**
     * Deductions: pre-tax treatment per T4127 factor. 'pension_f' = RPP/RRSP
     * (factor F), 'union_dues' = U1, 'alimony' = F2, 'none' = after-tax.
     */
    taxTreatment: text("tax_treatment", {
      enum: ["none", "pension_f", "union_dues", "alimony"],
    }).notNull().default("none"),
    /** DR for earnings/employer contributions (default wage expense if null). */
    expenseAccountId: uuid("expense_account_id"),
    /** CR for deductions/employer contributions/accruals. */
    liabilityAccountId: uuid("liability_account_id"),
    /** Vendor the withheld/accrued amount is remitted to (CRA, union, fund). */
    remittancePartyId: uuid("remittance_party_id"),
    sequence: integer("sequence").notNull().default(100),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("pay_components_org_code").on(t.orgId, t.code),
    uniqueIndex("pay_components_org_system").on(t.orgId, t.systemKey, t.kind),
    index("pay_components_org_kind").on(t.orgId, t.kind),
  ],
);

/** Per-employee payroll facts: TD1/W-4 claims, jurisdiction, schedule, exemptions. */
export const employeePayrollProfiles = pgTable(
  "employee_payroll_profiles",
  {
    id: id(),
    orgId: orgRef(),
    employeePartyId: uuid("employee_party_id").notNull(),
    payScheduleId: uuid("pay_schedule_id").notNull(),
    /** Statutory country pack this employee runs under. */
    country: text("country", { enum: ["CA", "US"] }).notNull().default("CA"),
    /** Jurisdiction of employment within the country: T4127 province ('ON',
     * 'QC', 'ZZ') for Canada, state postal code ('TX', 'WA', …) for the US. */
    province: text("province").notNull(),
    payBasis: text("pay_basis", { enum: ["hourly", "salary"] }).notNull().default("hourly"),
    /** TD1 federal claim: code 0–10, or an exact amount which wins over code. */
    federalClaimCode: integer("federal_claim_code"),
    federalClaimAmount: money("federal_claim_amount"),
    provincialClaimCode: integer("provincial_claim_code"),
    provincialClaimAmount: money("provincial_claim_amount"),
    /** TD1 extras (annual unless noted). */
    additionalTaxPerPeriod: money("additional_tax_per_period"),
    prescribedZoneDeduction: money("prescribed_zone_deduction"),
    authorizedAnnualDeductions: money("authorized_annual_deductions"),
    authorizedFederalCredits: money("authorized_federal_credits"),
    authorizedProvincialCredits: money("authorized_provincial_credits"),
    cppExempt: boolean("cpp_exempt").notNull().default(false),
    eiExempt: boolean("ei_exempt").notNull().default(false),
    /** Claim code E / CRA letter / W-4 "Exempt": no income tax withholding
     * (statutory contributions still deducted). */
    taxExempt: boolean("tax_exempt").notNull().default(false),
    /** US W-4 (2020 or later): Step 1(c), Step 2 checkbox, Step 3 annual
     * credits, Step 4(a)/(b) annual amounts. Step 4(c) reuses
     * additional_tax_per_period. */
    filingStatus: text("filing_status", {
      enum: ["single", "married_joint", "head_household"],
    }),
    multipleJobs: boolean("multiple_jobs").notNull().default(false),
    dependentCredits: money("dependent_credits"),
    otherIncomeAnnual: money("other_income_annual"),
    deductionsAnnual: money("deductions_annual"),
    /** 2019-or-earlier W-4 on file: withhold from allowances instead. */
    w4Pre2020: boolean("w4_pre_2020").notNull().default(false),
    w4Allowances: integer("w4_allowances"),
    /** US statutory exemptions (F-1 students, some family employment). */
    ficaExempt: boolean("fica_exempt").notNull().default(false),
    futaExempt: boolean("futa_exempt").notNull().default(false),
    /** Vacation pay percent (4.00 = 4%) and whether it accrues or pays out. */
    vacationPercent: numeric("vacation_percent", { precision: 7, scale: 4 }),
    vacationMethod: text("vacation_method", {
      enum: ["accrue", "pay_each_period"],
    }).notNull().default("accrue"),
    /** Union membership: drives dues, fringes, and remittance reporting. */
    unionAgreementId: uuid("union_agreement_id"),
    unionClassificationId: uuid("union_classification_id"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("employee_payroll_profiles_employee").on(t.orgId, t.employeePartyId),
    index("employee_payroll_profiles_schedule").on(t.orgId, t.payScheduleId),
    check("employee_payroll_profiles_fed_code",
      sql`${t.federalClaimCode} is null or (${t.federalClaimCode} >= 0 and ${t.federalClaimCode} <= 10)`),
    check("employee_payroll_profiles_prov_code",
      sql`${t.provincialClaimCode} is null or (${t.provincialClaimCode} >= 0 and ${t.provincialClaimCode} <= 10)`),
    check("employee_payroll_profiles_vacation",
      sql`${t.vacationPercent} is null or ${t.vacationPercent} >= 0`),
    check("employee_payroll_profiles_allowances",
      sql`${t.w4Allowances} is null or ${t.w4Allowances} >= 0`),
  ],
);

/** Recurring per-employee component assignments (effective-dated). */
export const employeePayComponents = pgTable(
  "employee_pay_components",
  {
    id: id(),
    orgId: orgRef(),
    employeePartyId: uuid("employee_party_id").notNull(),
    componentId: uuid("component_id").notNull(),
    /** Overrides the component default (amount, hourly rate, or percent). */
    value: money("value"),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    index("employee_pay_components_employee").on(t.orgId, t.employeePartyId, t.effectiveFrom),
    check("employee_pay_components_range",
      sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`),
  ],
);

/** 1:1 extension of documents kind 'pay_run'. */
export const payRuns = pgTable(
  "pay_runs",
  {
    documentId: uuid("document_id").primaryKey(),
    orgId: orgRef(),
    payScheduleId: uuid("pay_schedule_id").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    payDate: date("pay_date").notNull(),
    taxYear: integer("tax_year").notNull(),
    /** Calculation lifecycle; posting state lives on the document. */
    runStatus: text("run_status", {
      enum: ["draft", "calculated", "committed"],
    }).notNull().default("draft"),
    grossTotal: money("gross_total").notNull().default("0"),
    netTotal: money("net_total").notNull().default("0"),
    employerCostTotal: money("employer_cost_total").notNull().default("0"),
    employeeCount: integer("employee_count").notNull().default(0),
    calculatedAt: timestamp("calculated_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    index("pay_runs_org_period").on(t.orgId, t.periodStart, t.periodEnd),
    uniqueIndex("pay_runs_schedule_period").on(t.orgId, t.payScheduleId, t.periodEnd),
    check("pay_runs_period_order", sql`${t.periodEnd} >= ${t.periodStart}`),
    check("pay_runs_pay_date", sql`${t.payDate} >= ${t.periodEnd}`),
  ],
);

/** One employee's pay for one run, with the full T4127 explainability trace. */
export const payStubs = pgTable(
  "pay_stubs",
  {
    id: id(),
    orgId: orgRef(),
    payRunDocumentId: uuid("pay_run_document_id").notNull(),
    employeePartyId: uuid("employee_party_id").notNull(),
    /** Snapshot: recalculation never depends on the live profile. */
    province: text("province").notNull(),
    periodsPerYear: integer("periods_per_year").notNull(),
    payDate: date("pay_date").notNull(),
    taxYear: integer("tax_year").notNull(),
    federalClaim: money("federal_claim").notNull().default("0"),
    provincialClaim: money("provincial_claim").notNull().default("0"),
    currency: currencyCode("currency").notNull(),
    gross: money("gross").notNull().default("0"),
    pensionableEarnings: money("pensionable_earnings").notNull().default("0"),
    insurableEarnings: money("insurable_earnings").notNull().default("0"),
    netPay: money("net_pay").notNull().default("0"),
    employerCost: money("employer_cost").notNull().default("0"),
    vacationAccrued: money("vacation_accrued").notNull().default("0"),
    /** Every T4127 factor (A, K1…K4, T1…T4, V1, V2, S, TB…) for the trace UI. */
    factors: jsonb("factors").notNull().default(sql`'{}'::jsonb`),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("pay_stubs_run_employee").on(t.payRunDocumentId, t.employeePartyId),
    index("pay_stubs_employee_year").on(t.orgId, t.employeePartyId, t.taxYear, t.payDate),
    check("pay_stubs_net_nonnegative", sql`${t.netPay} >= 0`),
  ],
);

/** Component lines under a stub; job-cost splits carry dimensions. */
export const payStubLines = pgTable(
  "pay_stub_lines",
  {
    id: id(),
    orgId: orgRef(),
    stubId: uuid("stub_id").notNull(),
    componentId: uuid("component_id"),
    kind: text("kind", {
      enum: ["earning", "deduction", "employer_contribution"],
    }).notNull(),
    description: text("description").notNull(),
    hours: numeric("hours", { precision: 12, scale: 2 }),
    rate: money("rate"),
    amount: money("amount").notNull(),
    projectId: uuid("project_id"),
    departmentId: uuid("department_id"),
    timeTypeId: uuid("time_type_id"),
    sequence: integer("sequence").notNull().default(100),
    ...auditColumns,
  },
  (t) => [
    index("pay_stub_lines_stub").on(t.stubId, t.sequence),
    index("pay_stub_lines_project").on(t.orgId, t.projectId),
  ],
);

/** Mid-year adoption: YTD amounts accumulated before OpenBooks payroll. */
export const payrollOpeningBalances = pgTable(
  "payroll_opening_balances",
  {
    id: id(),
    orgId: orgRef(),
    employeePartyId: uuid("employee_party_id").notNull(),
    taxYear: integer("tax_year").notNull(),
    pensionableYtd: money("pensionable_ytd").notNull().default("0"),
    insurableYtd: money("insurable_ytd").notNull().default("0"),
    cppYtd: money("cpp_ytd").notNull().default("0"),
    cpp2Ytd: money("cpp2_ytd").notNull().default("0"),
    eiYtd: money("ei_ytd").notNull().default("0"),
    qpipYtd: money("qpip_ytd").notNull().default("0"),
    taxableYtd: money("taxable_ytd").notNull().default("0"),
    taxYtd: money("tax_ytd").notNull().default("0"),
    nonPeriodicYtd: money("non_periodic_ytd").notNull().default("0"),
    vacationBalance: money("vacation_balance").notNull().default("0"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("payroll_opening_balances_employee_year").on(
      t.orgId, t.employeePartyId, t.taxYear,
    ),
  ],
);

/**
 * Union construction layer.
 *
 * A collective agreement names the union/local and its remittance party; its
 * classifications identify trades/levels; its fringes are the per-hour or
 * percent-of-gross amounts (employer-paid burdens like pension/health/training
 * funds, or employee-paid dues). WAGE SCALE deliberately stays out: wages have
 * one home (labor_cost_rates), so scale updates are pushed into employee wage
 * rows, never resolved from a second table.
 *
 * Each fringe auto-provisions a linked pay_component carrying its GL accounts
 * and remittance party, so pay stubs and the commit path treat fringe lines
 * exactly like any other component line. Employee-paid dues components use
 * tax_treatment 'union_dues', which feeds T4127 factor U1 automatically.
 */
export const unionAgreements = pgTable(
  "union_agreements",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    unionName: text("union_name"),
    localNumber: text("local_number"),
    /** Vendor the monthly remittance report/payment goes to. */
    remittancePartyId: uuid("remittance_party_id"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [uniqueIndex("union_agreements_org_name").on(t.orgId, t.name)],
);

export const unionClassifications = pgTable(
  "union_classifications",
  {
    id: id(),
    orgId: orgRef(),
    agreementId: uuid("agreement_id").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [uniqueIndex("union_classifications_agreement_code").on(t.agreementId, t.code)],
);

export const unionFringes = pgTable(
  "union_fringes",
  {
    id: id(),
    orgId: orgRef(),
    agreementId: uuid("agreement_id").notNull(),
    /** Null = applies to every classification under the agreement. */
    classificationId: uuid("classification_id"),
    code: text("code").notNull(),
    name: text("name").notNull(),
    calc: text("calc", {
      enum: ["per_hour_worked", "percent_of_gross"],
    }).notNull(),
    value: money("value").notNull(),
    paidBy: text("paid_by", { enum: ["employer", "employee"] }).notNull(),
    /** Employer fringes tagged job_costed split by project like wages. */
    jobCosted: boolean("job_costed").notNull().default(true),
    /** Auto-provisioned pay component carrying GL accounts + remittance. */
    componentId: uuid("component_id"),
    sequence: integer("sequence").notNull().default(100),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("union_fringes_agreement_code").on(t.agreementId, t.code),
    index("union_fringes_agreement").on(t.orgId, t.agreementId),
    check("union_fringes_value_nonnegative", sql`${t.value} >= 0`),
  ],
);

/**
 * Run-level input adjustments — the controlled alternative to editing
 * calculated stubs. 'line' adds a one-off amount against a component for one
 * employee in one run (replaceComponent swaps out that component's derived
 * lines instead of adding); 'exclude' drops the employee from the run.
 * Calculate merges these as INPUTS and recomputes the statutory math, so
 * CPP/EI/tax always remain the engine's numbers for the actual pay.
 */
export const payRunAdjustments = pgTable(
  "pay_run_adjustments",
  {
    id: id(),
    orgId: orgRef(),
    payRunDocumentId: uuid("pay_run_document_id").notNull(),
    employeePartyId: uuid("employee_party_id").notNull(),
    adjustmentType: text("adjustment_type", { enum: ["line", "exclude"] }).notNull(),
    componentId: uuid("component_id"),
    amount: money("amount"),
    /** Display-only context for hours-shaped one-offs (retro hours etc.). */
    hours: numeric("hours", { precision: 12, scale: 2 }),
    replaceComponent: boolean("replace_component").notNull().default(false),
    note: text("note"),
    ...auditColumns,
  },
  (t) => [
    index("pay_run_adjustments_run").on(t.orgId, t.payRunDocumentId, t.employeePartyId),
    check("pay_run_adjustments_line_shape",
      sql`${t.adjustmentType} <> 'line' or (${t.componentId} is not null and ${t.amount} is not null)`),
  ],
);

// Foreign keys are maintained in the migration (DEFERRABLE, per house rule).
