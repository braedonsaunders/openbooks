/** Setup-registry workforce entities (split from registry.ts; pure moves only). */
import type { SetupEntity, SetupEntityValidationHook } from '../types'
import { featureEnabled } from '@openbooks/engine/src/organization/feature-registry.ts'
import { OVERHEAD_RATE_KINDS, OVERHEAD_RATE_METHODS, PAY_FREQUENCIES, PAY_COMPONENT_KINDS, PAY_COMPONENT_COUNTRIES, PAY_COMPONENT_BASES, PAY_SUPPLEMENTAL_WAGE_CATEGORIES, PAY_STATUTORY_EXEMPTION_CATEGORIES, PAY_TAX_TREATMENTS, PAY_PROTECTION_BASES, PAY_PROTECTED_BASES, PAYROLL_PROGRAM_TYPES, PAYROLL_REMITTER_TYPES, ENTITLEMENT_UNITS, ENTITLEMENT_DIRECTIONS, ENTITLEMENT_ACCRUAL_METHODS, ENTITLEMENT_CAP_BEHAVIORS } from '../options'
import { PAY_DERIVED_RULE_ENTITIES } from '../payroll-derived-rules'
import { PAYROLL_HOLIDAYS_ENTITY } from '../payroll-holidays'
import { LEAVE_POLICIES_ENTITY, LEAVE_TYPES_ENTITY } from '../hrm-leave'
import { ACTION_REASONS_ENTITY } from '../hrm-action-reasons'
import { DOCUMENT_CATEGORIES_ENTITY, DOCUMENT_TEMPLATES_ENTITY, RETENTION_SCHEDULES_ENTITY } from '../hrm-documents'
import { BENEFIT_PLANS_ENTITY } from '../hrm-benefits'
import { BENEFIT_CONTRIBUTION_ENTITIES } from '../hrm-benefit-contributions'
import { PAYROLL_SERVICE_CREDITS_ENTITY } from '../payroll-service-credits'
import { PAYROLL_VACATION_TERMS_ENTITY } from '../payroll-vacation-terms'
import { BENEFIT_PROGRAMS_ENTITY, BENEFIT_PROGRAM_SCOPES_ENTITY, BENEFIT_PROGRAM_SOURCES_ENTITY, BENEFIT_PROGRAM_MEMBERS_ENTITY } from '../benefit-programs'
import { JOB_FAMILIES_ENTITY, JOB_LEVELS_ENTITY, PAY_BANDS_ENTITY } from '../hrm-compensation'
import { CONSTRUCTION_CLASSIFICATIONS_ENTITY, CONSTRUCTION_COMP_CLASSES_ENTITY, CONSTRUCTION_PER_DIEM_POLICIES_ENTITY, CONSTRUCTION_RATE_SCHEDULES_ENTITY, CONSTRUCTION_RATIO_RULES_ENTITY } from '../hrm-construction'
import { QUALIFICATION_SETTINGS_ENTITY, QUALIFICATION_TYPES_ENTITY } from '../hrm-qualifications'
import { AI_RAILS_SETTINGS_ENTITY } from '../hrm-ai-rails'
import { PROJECT_GEOFENCES_ENTITY, TIME_KIOSKS_ENTITY } from '../field-time'

/**
 * Rate kinds a projects-only org may write: the historical project contract
 * ($/labor hour, percent of labor). The machine-hour and per-unit kinds are
 * manufacturing bases with no project meaning until Manufacturing is on.
 */
const OVERHEAD_PROJECT_RATE_KINDS = ['per_hour', 'percent']

/**
 * Rate kinds a manufacturing-only org may write: the routing bases read
 * these three card kinds (labor hours → $/labor hour, machine hours →
 * $/machine hour, units → $/unit). Percent of labor is a Projects costing
 * card with no manufacturing basis.
 */
const OVERHEAD_MANUFACTURING_RATE_KINDS = ['per_hour', 'per_machine_hour', 'per_unit']

const OVERHEAD_METHOD_NAMES: Record<string, string> = {
  live: 'Live',
  three_year_average: 'Three-year average',
}

const OVERHEAD_KIND_NAMES: Record<string, string> = {
  percent: 'Percent of labor',
  per_machine_hour: '$/machine hour',
  per_unit: '$/unit',
}

/**
 * Each feature combination gets exactly the cards its consumers can read.
 * Projects-only keeps the historical project kinds ($/labor hour, percent of
 * labor) while the manufacturing kinds refuse by name with the remedy that
 * admits them; manufacturing-only keeps the Standard method with the routing
 * basis kinds while project cards refuse by name the same way; both on allow
 * the union without reinterpretation. Both off is the shared any-of gate's
 * refusal — this hook never re-adjudicates the gate — and deletes never
 * reach it (the write path skips validation when there is no body, so
 * preserved history stays deletable while a feature is off).
 */
const validateOverheadRateWrite: SetupEntityValidationHook = async ({ orgId, body, rowId, executor }) => {
  // This module rides the client registry bundle, so the query builder stays
  // out of the top-level imports and loads lazily: the hook only ever runs
  // inside the server write path (stripped from client descriptors).
  const { sql } = await import('drizzle-orm')
  const stored = (await executor.execute<{ f: Record<string, boolean> | null }>(
    sql`select settings->'features' as f from orgs where id = ${orgId}`,
  )).rows[0]?.f ?? {}
  const projectsOn = featureEnabled(stored, 'projects')
  const manufacturingOn = featureEnabled(stored, 'manufacturing')
  if (!projectsOn && !manufacturingOn) return null
  const current = rowId
    ? (await executor.execute<{ method: string | null; rate_kind: string | null }>(
      sql`select method, rate_kind from overhead_rates where id = ${rowId} and org_id = ${orgId}`,
    )).rows[0]
    : null
  if (rowId && !current) return 'not found'
  const kind = body.rateKind === undefined || body.rateKind === null
    ? (current?.rate_kind ?? 'per_hour')
    : String(body.rateKind)
  if (projectsOn && manufacturingOn) return null
  if (projectsOn) {
    if (!OVERHEAD_PROJECT_RATE_KINDS.includes(kind)) {
      return `The ${OVERHEAD_KIND_NAMES[kind] ?? kind} overhead kind needs Manufacturing: use $/labor hour or percent of labor, or turn on Manufacturing in Company Settings → Features.`
    }
    return null
  }
  // An omitted method falls through to the storage default (live), which has
  // no manufacturing basis — fail closed rather than store a card the
  // requester never named.
  const method = body.method === undefined || body.method === null
    ? (current?.method ?? 'live')
    : String(body.method)
  if (method !== 'standard') {
    return `The ${OVERHEAD_METHOD_NAMES[method] ?? method} overhead method needs Projects: use the Standard method, or turn on Projects in Company Settings → Features.`
  }
  if (!OVERHEAD_MANUFACTURING_RATE_KINDS.includes(kind)) {
    return `The ${OVERHEAD_KIND_NAMES[kind] ?? kind} overhead kind needs Projects: use $/labor hour, $/machine hour, or $/unit, or turn on Projects in Company Settings → Features.`
  }
  return null
}

export const WORKFORCE_ENTITIES: SetupEntity[] = [
  // --- Workforce -----------------------------------------------------------
  {
    key: 'time-types',
    table: 'time_types',
    groupKey: 'workforce',
    featureKey: 'timeTracking',
    iconKey: 'timer',
    orgScoped: true,
    // cost_multiplier / exclude_from_wages are direct inputs to gross earnings,
    // so the table carries the audit quartet and the generic route must stamp it.
    actorCols: true,
    orderBy: 'name',
    hasActive: true,
    columns: [
      { key: 'name', kind: 'text' },
      {
        key: 'classification',
        kind: 'badge',
        options: [
          { value: 'regular', labelKey: 'options.timeClassification.regular' },
          { value: 'overtime', labelKey: 'options.timeClassification.overtime' },
          { value: 'double_time', labelKey: 'options.timeClassification.doubleTime' },
          { value: 'other', labelKey: 'options.timeClassification.other' },
        ],
      },
      { key: 'costMultiplier', kind: 'number' },
      { key: 'billMultiplier', kind: 'number' },
      { key: 'isBillableDefault', kind: 'boolean' },
      { key: 'showOnFieldTicket', kind: 'boolean' },
      { key: 'excludeFromWages', kind: 'boolean' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'name', kind: 'text', required: true },
      {
        key: 'classification',
        kind: 'select',
        required: true,
        keepDefault: true,
        defaultValue: 'regular',
        options: [
          { value: 'regular', labelKey: 'options.timeClassification.regular' },
          { value: 'overtime', labelKey: 'options.timeClassification.overtime' },
          { value: 'double_time', labelKey: 'options.timeClassification.doubleTime' },
          { value: 'other', labelKey: 'options.timeClassification.other' },
        ],
      },
      { key: 'costMultiplier', kind: 'decimal', keepDefault: true },
      { key: 'billMultiplier', kind: 'decimal', keepDefault: true },
      { key: 'isBillableDefault', kind: 'boolean' },
      { key: 'showOnFieldTicket', kind: 'boolean' },
      { key: 'excludeFromWages', kind: 'boolean', helpTextKey: 'fieldHelp.excludeFromWages' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    // Payroll program / EIN / state-SUI accounts the employer files and remits
    // under. Employees are assigned one on their payroll profile; remittance
    // runs, PD7A worksheets, and the T4/W-2 returns all group by it.
    key: 'payroll-filing-accounts',
    table: 'payroll_filing_accounts',
    groupKey: 'workforce',
    featureKey: 'payroll',
    rehomed: true, // subtab of the Payroll setup workspace
    iconKey: 'landmark',
    orgScoped: true,
    actorCols: true,
    naturalKey: 'accountNumber',
    hasActive: true,
    columns: [
      { key: 'accountNumber', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'country', kind: 'badge', options: PAY_COMPONENT_COUNTRIES, optionsSource: 'payroll-filing-countries' },
      { key: 'programType', kind: 'badge', options: PAYROLL_PROGRAM_TYPES, optionsSource: 'payroll-filing-program-types' },
      { key: 'remitterType', kind: 'badge', options: PAYROLL_REMITTER_TYPES },
      { key: 'stateCode', kind: 'text' },
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries' },
      { key: 'isDefault', kind: 'boolean' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    filters: [{ key: 'country', options: PAY_COMPONENT_COUNTRIES, optionsSource: 'payroll-filing-countries' }],
    fields: [
      { key: 'accountNumber', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      // Country and program type come from the DECLARED payroll packs at
      // render time (optionsSource) — the API validates against the same
      // declarations (filingAccountProblem), so a registered pack's program
      // types are offered and accepted with no edit to this file.
      { key: 'country', kind: 'select', required: true, options: PAY_COMPONENT_COUNTRIES, optionsSource: 'payroll-filing-countries' },
      { key: 'programType', kind: 'select', required: true, options: PAYROLL_PROGRAM_TYPES, optionsSource: 'payroll-filing-program-types' },
      { key: 'remitterType', kind: 'select', keepDefault: true, defaultValue: 'regular', options: PAYROLL_REMITTER_TYPES },
      // Required for, and only for, program types declared `requiresRegion`
      // (us_state_sui) — enforced by `filingAccountProblem` at the API
      // boundary, not by a DB check any more.
      { key: 'stateCode', kind: 'text', helpTextKey: 'fieldHelp.stateCode' },
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries' },
      { key: 'isDefault', kind: 'boolean', helpTextKey: 'fieldHelp.filingAccountDefault' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  // Elections on the country pack's OPTIONAL statutory holidays, plus company
  // closures. Declared in ./payroll-holidays.ts; an ordinary registry entity.
  PAYROLL_HOLIDAYS_ENTITY,
  // HR leave taxonomy and time-entitlement policies. Declared in
  // ./hrm-leave.ts; ordinary registry entities behind the hrm switch.
  LEAVE_TYPES_ENTITY,
  LEAVE_POLICIES_ENTITY,
  // HR action/reason codes. Declared in ./hrm-action-reasons.ts; rehomed
  // onto /hrm/change-requests (never a standalone setup page).
  // HR-16 begin
  ACTION_REASONS_ENTITY,
  // HR-16 end
  // HR documents (0230, HR-19): categories, templates, and retention
  // schedules. Rehomed as sections onto /hrm/documents (never standalone
  // setup pages); the Setup generic write path shares the engine
  // validation through normalizeHrmDocumentTemplateInput +
  // validateEntityIntegrity.
  // HR-19 begin
  DOCUMENT_CATEGORIES_ENTITY,
  DOCUMENT_TEMPLATES_ENTITY,
  RETENTION_SCHEDULES_ENTITY,
  // HR-19 end
  // HRM benefit plans and ordered pricing tiers. Declared in
  // ./hrm-benefits.ts; ordinary registry entities behind the hrm switch.
  BENEFIT_PLANS_ENTITY,
  ...BENEFIT_CONTRIBUTION_ENTITIES,
  PAYROLL_SERVICE_CREDITS_ENTITY,
  PAYROLL_VACATION_TERMS_ENTITY,
  BENEFIT_PROGRAMS_ENTITY,
  BENEFIT_PROGRAM_SCOPES_ENTITY,
  BENEFIT_PROGRAM_SOURCES_ENTITY,
  BENEFIT_PROGRAM_MEMBERS_ENTITY,
  // HRM compensation architecture (0221, HR-12): job families, levels
  // and versioned pay bands behind the hrmCompensation switch, rehomed
  // as sections onto the Compensation page.
  // HR-12 begin
  JOB_FAMILIES_ENTITY,
  JOB_LEVELS_ENTITY,
  PAY_BANDS_ENTITY,
  // HR-12 end
  // HR-13 begin: construction classifications, rate schedules, comp
  // classes, per-diem policies and ratio rules. Declared in
  // ./hrm-construction.ts; rehomed onto the HRM Compliance page.
  CONSTRUCTION_CLASSIFICATIONS_ENTITY,
  CONSTRUCTION_RATE_SCHEDULES_ENTITY,
  CONSTRUCTION_COMP_CLASSES_ENTITY,
  CONSTRUCTION_PER_DIEM_POLICIES_ENTITY,
  CONSTRUCTION_RATIO_RULES_ENTITY,
  // HR-13 end
  // HR-14 begin: qualification taxonomy and extended vocabulary.
  // Declared in ./hrm-qualifications.ts; rehomed onto the HRM
  // Qualifications page.
  QUALIFICATION_TYPES_ENTITY,
  QUALIFICATION_SETTINGS_ENTITY,
  // HR-14 end
  // Project geofences and kiosk devices. Declared in ./field-time.ts;
  // rehomed onto the project page and the Timesheets setup surface.
  PROJECT_GEOFENCES_ENTITY,
  TIME_KIOSKS_ENTITY,
  // HR-21 begin: AI rails thresholds, cohort, bias terms and review
  // cadence. Declared in ./hrm-ai-rails.ts; rehomed onto /admin/ai.
  AI_RAILS_SETTINGS_ENTITY,
  // HR-21 end
  {
    key: 'pay-schedules',
    table: 'pay_schedules',
    groupKey: 'workforce',
    featureKey: 'payroll',
    rehomed: true, // subtab of the Payroll setup workspace
    iconKey: 'calendar',
    orgScoped: true,
    actorCols: true,
    naturalKey: 'name',
    hasActive: true,
    columns: [
      { key: 'name', kind: 'text' },
      { key: 'frequency', kind: 'badge', options: PAY_FREQUENCIES },
      { key: 'periodsPerYear', kind: 'number' },
      { key: 'anchorPeriodEnd', kind: 'date' },
      { key: 'payDateOffsetDays', kind: 'number' },
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'name', kind: 'text', required: true },
      { key: 'frequency', kind: 'select', required: true, options: PAY_FREQUENCIES },
      { key: 'periodsPerYear', kind: 'integer', required: true },
      { key: 'anchorPeriodEnd', kind: 'date', required: true, helpTextKey: 'fieldHelp.payScheduleAnchor' },
      // Legal entity this calendar pays; empty = org-wide (root subsidiary).
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries' },
      { key: 'payDateOffsetDays', kind: 'integer', keepDefault: true },
      { key: 'isDefault', kind: 'boolean' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    key: 'pay-components',
    table: 'pay_components',
    groupKey: 'workforce',
    featureKey: 'payroll',
    rehomed: true, // subtab of the Payroll setup workspace
    iconKey: 'coins',
    orgScoped: true,
    actorCols: true,
    naturalKey: 'code',
    orderBy: 'sequence, code',
    hasActive: true,
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'kind', kind: 'badge', options: PAY_COMPONENT_KINDS },
      { key: 'country', kind: 'badge', options: PAY_COMPONENT_COUNTRIES, optionsSource: 'payroll-component-countries' },
      { key: 'basis', kind: 'badge', options: PAY_COMPONENT_BASES },
      { key: 'sequence', kind: 'number' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    // Country pack filter: a chosen country also shows shared (country-less)
    // components, since those apply to every pack's employees.
    filters: [
      { key: 'country', options: PAY_COMPONENT_COUNTRIES, optionsSource: 'payroll-component-countries', nullMatchesAll: true },
      { key: 'kind', options: PAY_COMPONENT_KINDS },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      { key: 'kind', kind: 'select', required: true, options: PAY_COMPONENT_KINDS },
      {
        key: 'paymentKind', kind: 'select', keepDefault: true, defaultValue: 'cash',
        options: [{ value: 'cash', labelKey: 'options.payPaymentKind.cash' }, { value: 'non_cash', labelKey: 'options.payPaymentKind.nonCash' }],
        showWhen: { field: 'kind', in: ['earning'] }, helpTextKey: 'fieldHelp.paymentKind',
      },
      {
        key: 'nonCashAccountId', kind: 'ref', ref: 'accounts',
        showWhen: { field: 'paymentKind', in: ['non_cash'] }, helpTextKey: 'fieldHelp.nonCashAccountId',
      },
      // Every installable pack, resolved at render time — the static pair
      // is the fallback for surfaces that render without resolving.
      { key: 'country', kind: 'select', options: PAY_COMPONENT_COUNTRIES, optionsSource: 'payroll-component-countries' },
      { key: 'basis', kind: 'select', keepDefault: true, defaultValue: 'fixed_amount', options: PAY_COMPONENT_BASES },
      { key: 'value', kind: 'decimal' },
      { key: 'taxable', kind: 'boolean', defaultValue: true },
      { key: 'pensionable', kind: 'boolean', defaultValue: true },
      { key: 'insurable', kind: 'boolean', defaultValue: true },
      // Contribution programs this earning does NOT feed, as program keys
      // (engine/src/payroll/packs.ts `contributionPrograms` — today only the
      // CA pack's `qpip`). Empty feeds every declared program, matching the
      // sibling flags' default-true; a key no pack declares is inert on runs.
      // Chip input with type-ahead over the packs' declared programs (free
      // entry for the rest). Earnings-only: the accumulation reads
      // applicability on earning lines alone, so offering it on a deduction
      // would be a setting that changes nothing (the protection precedent).
      {
        key: 'programExclusions', kind: 'stringArray', arrayStorage: 'text',
        optionsSource: 'payroll-contribution-programs',
        showWhen: { field: 'kind', in: ['earning'] },
      },
      { key: 'vacationable', kind: 'boolean', defaultValue: true },
      { key: 'nonPeriodic', kind: 'boolean' },
      {
        key: 'supplementalWageCategory', kind: 'select',
        options: PAY_SUPPLEMENTAL_WAGE_CATEGORIES,
        showWhen: { field: 'kind', in: ['earning'] },
      },
      {
        key: 'statutoryExemptionCategory', kind: 'select',
        options: PAY_STATUTORY_EXEMPTION_CATEGORIES,
        showWhen: { field: 'kind', in: ['earning'] },
      },
      {
        key: 'statutoryReportingCategory', kind: 'select',
        optionsSource: 'payroll-statutory-reporting-categories',
      },
      // Pre-tax treatments THE COMPONENT'S PACK declares, resolved per
      // country at render time (`scopedOptions`): an AU component offers
      // salary sacrifice, a CA one the T4127 factors, and a pack with no
      // transcribed treatment offers after-tax only. The static list is the
      // fallback for surfaces that render without resolving.
      { key: 'taxTreatment', kind: 'select', keepDefault: true, defaultValue: 'none', options: PAY_TAX_TREATMENTS, optionsSource: 'payroll-deduction-treatments' },
      // Deduction protection. Only money leaving the employee can be protected,
      // so the group hides on an earning or an employer contribution (the
      // pay_components CHECK constraint enforces the same rule).
      {
        key: 'protectionBase', kind: 'select', keepDefault: true, defaultValue: 'none',
        options: PAY_PROTECTION_BASES, sectionKey: 'sections.deductionProtection',
        showWhen: { field: 'kind', in: ['deduction'] },
        helpTextKey: 'fieldHelp.protectionBase',
      },
      {
        key: 'protectionMaxPercent', kind: 'percent', sectionKey: 'sections.deductionProtection',
        showWhen: { field: 'protectionBase', in: PAY_PROTECTED_BASES },
        helpTextKey: 'fieldHelp.protectionMaxPercent',
      },
      {
        key: 'protectionPriority', kind: 'integer', keepDefault: true, defaultValue: 100,
        sectionKey: 'sections.deductionProtection',
        showWhen: { field: 'protectionBase', in: PAY_PROTECTED_BASES },
        helpTextKey: 'fieldHelp.protectionPriority',
      },
      // Pool membership is a property of earnings AND deductions: it is what
      // keeps an allowance or a benefit outside the base an order is measured
      // against, without a line of code knowing what a coverall is.
      {
        key: 'includeInDisposableEarnings', kind: 'boolean', defaultValue: true,
        sectionKey: 'sections.deductionProtection',
        showWhen: { field: 'kind', in: ['earning', 'deduction'] },
        helpTextKey: 'fieldHelp.includeInDisposableEarnings',
      },
      // Basis caps: the hours cap only means something once the amount is
      // driven by hours; the money caps apply to every basis.
      {
        key: 'basisCapHoursPerPeriod', kind: 'decimal', sectionKey: 'sections.basisCaps',
        showWhen: { field: 'basis', in: ['per_hour', 'percent_of_gross'] },
        helpTextKey: 'fieldHelp.basisCapHoursPerPeriod',
      },
      {
        key: 'basisCapAmountPerPeriod', kind: 'decimal', sectionKey: 'sections.basisCaps',
        helpTextKey: 'fieldHelp.basisCapAmountPerPeriod',
      },
      {
        key: 'basisCapAmountPerYear', kind: 'decimal', sectionKey: 'sections.basisCaps',
        helpTextKey: 'fieldHelp.basisCapAmountPerYear',
      },
      { key: 'expenseAccountId', kind: 'ref', ref: 'accounts' },
      { key: 'liabilityAccountId', kind: 'ref', ref: 'accounts' },
      { key: 'remittancePartyId', kind: 'ref', ref: 'vendors' },
      { key: 'sequence', kind: 'integer', keepDefault: true },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    // Collective agreements (union/local + remittance vendor). Classifications
    // and fringes are agreement-scoped children that need a parent detail
    // surface to edit — they stay off the registry until that surface exists.
    key: 'union-agreements',
    table: 'union_agreements',
    groupKey: 'workforce',
    featureKey: 'payroll',
    rehomed: true, // subtab of the Payroll setup workspace
    iconKey: 'users',
    orgScoped: true,
    actorCols: true,
    naturalKey: 'name',
    hasActive: true,
    columns: [
      { key: 'name', kind: 'text' },
      { key: 'unionName', kind: 'text' },
      { key: 'localNumber', kind: 'text' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'name', kind: 'text', required: true },
      { key: 'unionName', kind: 'text' },
      { key: 'localNumber', kind: 'text' },
      { key: 'remittancePartyId', kind: 'ref', ref: 'vendors' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    // Pay banks: banked overtime, vacation, sick banks, and benefit recoup
    // while an employee is on leave (direction 'owe' — a NEGATIVE balance
    // repaid over time). The balance is SUM(entitlement_ledger); there is no
    // balance column anywhere and this surface never writes one.
    key: 'entitlement-plans',
    table: 'entitlement_plans',
    singularTitleKey: 'entities.entitlement-plans.singular',
    groupKey: 'workforce',
    featureKey: 'payroll',
    rehomed: true, // subtab of the Payroll setup workspace
    iconKey: 'coins',
    orgScoped: true,
    actorCols: true,
    naturalKey: 'code',
    hasActive: true,
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'direction', kind: 'badge', options: ENTITLEMENT_DIRECTIONS },
      { key: 'unit', kind: 'badge', options: ENTITLEMENT_UNITS },
      { key: 'accrualMethod', kind: 'badge', options: ENTITLEMENT_ACCRUAL_METHODS },
      { key: 'accrualValue', kind: 'number' },
      { key: 'capBehavior', kind: 'badge', options: ENTITLEMENT_CAP_BEHAVIORS },
      { key: 'liabilityAccountId', kind: 'ref', ref: 'accounts' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    filters: [
      { key: 'direction', options: ENTITLEMENT_DIRECTIONS },
      { key: 'unit', options: ENTITLEMENT_UNITS },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      {
        key: 'unit', kind: 'select', required: true, keepDefault: true,
        defaultValue: 'money', options: ENTITLEMENT_UNITS,
        helpTextKey: 'fieldHelp.entitlementUnit',
      },
      {
        key: 'direction', kind: 'select', required: true, keepDefault: true,
        defaultValue: 'accrue', options: ENTITLEMENT_DIRECTIONS,
        helpTextKey: 'fieldHelp.entitlementDirection',
      },
      {
        key: 'accrualMethod', kind: 'select', required: true, keepDefault: true,
        defaultValue: 'manual', options: ENTITLEMENT_ACCRUAL_METHODS,
      },
      { key: 'accrualValue', kind: 'decimal', helpTextKey: 'fieldHelp.entitlementAccrualValue' },
      { key: 'accrualComponentId', kind: 'ref', ref: 'pay-components' },
      { key: 'payoutComponentId', kind: 'ref', ref: 'pay-components', helpTextKey: 'fieldHelp.entitlementPayoutComponent' },
      { key: 'liabilityAccountId', kind: 'ref', ref: 'accounts', helpTextKey: 'fieldHelp.entitlementLiabilityAccount' },
      {
        key: 'capBehavior', kind: 'select', keepDefault: true,
        defaultValue: 'warn', options: ENTITLEMENT_CAP_BEHAVIORS,
        helpTextKey: 'fieldHelp.entitlementCapBehavior',
      },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    // The scoped ceilings. "Trades $4,000 / Foremen $5,000 / Supers $6,000" is
    // three rows here, resolved most-specific-wins exactly like a wage on
    // labor_cost_rates (employee > job title > trade > department >
    // subsidiary > plan default, latest effective_from within a scope).
    key: 'entitlement-plan-limits',
    parentRecords: [{ entityKey: 'entitlement-plans', fieldKey: 'planId' }],
    table: 'entitlement_plan_limits',
    singularTitleKey: 'entities.entitlement-plan-limits.singular',
    groupKey: 'workforce',
    featureKey: 'payroll',
    rehomed: true, // subtab of the Payroll setup workspace
    iconKey: 'gauge',
    orgScoped: true,
    actorCols: true,
    orderBy: 'effective_from desc',
    hasActive: true,
    columns: [
      { key: 'planId', kind: 'ref', ref: 'entitlement-plans' },
      { key: 'employeePartyId', kind: 'ref', ref: 'employees' },
      { key: 'jobTitle', kind: 'text' },
      { key: 'tradeId', kind: 'ref', ref: 'trades' },
      { key: 'departmentId', kind: 'ref', ref: 'departments' },
      { key: 'maxBalance', kind: 'number' },
      { key: 'notifyBalance', kind: 'number' },
      { key: 'effectiveFrom', kind: 'date' },
      { key: 'effectiveTo', kind: 'date' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'planId', kind: 'ref', ref: 'entitlement-plans', required: true },
      // Exactly one scope key, or none for the plan-wide default (enforced by
      // the entitlement_plan_limits_one_scope check constraint).
      { key: 'employeePartyId', kind: 'ref', ref: 'employees', helpTextKey: 'fieldHelp.entitlementScope' },
      { key: 'jobTitle', kind: 'text' },
      { key: 'tradeId', kind: 'ref', ref: 'trades' },
      { key: 'departmentId', kind: 'ref', ref: 'departments' },
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries', legalEmployer: true, labelKey: 'fields.legalEmployer' },
      { key: 'maxBalance', kind: 'decimal', helpTextKey: 'fieldHelp.entitlementMaxBalance' },
      { key: 'notifyBalance', kind: 'decimal', helpTextKey: 'fieldHelp.entitlementNotifyBalance' },
      { key: 'effectiveFrom', kind: 'date', required: true },
      { key: 'effectiveTo', kind: 'date' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    // Service-based schedules: benefits at 3 months, RRSP at a year, the
    // vacation ladder at 5/10/15/20/25/30 years. A tier targets EXACTLY one of
    // a plan (raising its accrual value) or a pay component (eligibility on).
    key: 'entitlement-service-tiers',
    parentRecords: [
      { entityKey: 'entitlement-plans', fieldKey: 'planId' },
      { entityKey: 'pay-components', fieldKey: 'componentId' },
    ],
    table: 'entitlement_service_tiers',
    singularTitleKey: 'entities.entitlement-service-tiers.singular',
    groupKey: 'workforce',
    featureKey: 'payroll',
    rehomed: true, // subtab of the Payroll setup workspace
    iconKey: 'calendar',
    orgScoped: true,
    actorCols: true,
    orderBy: 'after_months',
    hasActive: true,
    columns: [
      { key: 'afterMonths', kind: 'number' },
      { key: 'planId', kind: 'ref', ref: 'entitlement-plans' },
      { key: 'componentId', kind: 'ref', ref: 'pay-components' },
      { key: 'employerSubsidiaryId', kind: 'ref', ref: 'subsidiaries' },
      { key: 'accrualValue', kind: 'number' },
      { key: 'annualDays', kind: 'number' },
      { key: 'effectiveFrom', kind: 'date' },
      { key: 'effectiveTo', kind: 'date' },
      { key: 'eligible', kind: 'boolean' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'afterMonths', kind: 'integer', required: true, helpTextKey: 'fieldHelp.entitlementAfterMonths' },
      { key: 'planId', kind: 'ref', ref: 'entitlement-plans', helpTextKey: 'fieldHelp.entitlementTierTarget' },
      { key: 'componentId', kind: 'ref', ref: 'pay-components' },
      { key: 'employerSubsidiaryId', kind: 'ref', ref: 'subsidiaries', legalEmployer: true, labelKey: 'fields.legalEmployer', helpTextKey: 'serviceCredit.employerTierHint' },
      { key: 'accrualValue', kind: 'decimal', decimalScale: 4, clearWhenHidden: true, showWhen: { field: 'planId', present: true } },
      { key: 'annualDays', kind: 'decimal', decimalScale: 4, clearWhenHidden: true, showWhen: { field: 'planId', present: true }, helpTextKey: 'serviceCredit.annualDaysHint' },
      { key: 'effectiveFrom', kind: 'date', required: true },
      { key: 'effectiveTo', kind: 'date' },
      { key: 'eligible', kind: 'boolean', nullable: true, required: true, clearWhenHidden: true, showWhen: { field: 'componentId', present: true } },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  // Derived earnings rules (+ the trades list their employee filter picks
  // from). Declared in ./payroll-derived-rules.ts so the money-rule editor
  // could be reviewed as one change; ordinary registry entities otherwise.
  ...PAY_DERIVED_RULE_ENTITIES,
  {
    key: 'worker-comp-groups',
    table: 'worker_comp_groups',
    groupKey: 'workforce',
    featureKey: 'timeTracking',
    iconKey: 'shield',
    orgScoped: true,
    // rate_percent / max_assessable are payroll MONEY inputs, so the table now
    // carries the audit quartet and the generic route must stamp it — a rate
    // change that leaves no updated_at is invisible to payRunStaleness.
    actorCols: true,
    naturalKey: 'code',
    hasActive: true,
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'ratePercent', kind: 'percent' },
      { key: 'maxAssessable', kind: 'number' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      // A worker-comp rate is a burden priced into every affected cost rate:
      // it cannot be negative (a negative rate silently reduced rates), and
      // the generic percent coercion otherwise admits negatives. The costing
      // read path refuses negative group rates by name as well, for rows
      // written around this rule.
      { key: 'ratePercent', kind: 'percent', min: 0 },
      { key: 'maxAssessable', kind: 'decimal', helpTextKey: 'fieldHelp.maxAssessable' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    key: 'overhead-rates',
    table: 'overhead_rates',
    singularTitleKey: 'entities.overhead-rates.singular',
    actorCols: true,
    groupKey: 'projects',
    // One shared card serves Projects or Manufacturing: the any-of gate admits
    // while either member is on, so the same rows cost jobs and absorb into
    // work orders without reinterpretation. Never declare featureKey
    // alongside it — a descriptor carrying both fails closed.
    featureKeysAny: ['projects', 'manufacturing'],
    iconKey: 'percent',
    orgScoped: true,
    orderBy: 'effective_from desc',
    hasActive: false,
    validateWrite: validateOverheadRateWrite,
    columns: [
      { key: 'departmentId', kind: 'ref', ref: 'departments' },
      { key: 'category', kind: 'text' },
      { key: 'ratePercent', kind: 'number' },
      { key: 'effectiveFrom', kind: 'date' },
      { key: 'effectiveTo', kind: 'date' },
    ],
    fields: [
      { key: 'departmentId', kind: 'ref', ref: 'departments' },
      { key: 'category', kind: 'text' },
      { key: 'method', kind: 'select', options: OVERHEAD_RATE_METHODS },
      { key: 'rateKind', kind: 'select', options: OVERHEAD_RATE_KINDS },
      { key: 'ratePercent', kind: 'decimal', required: true },
      { key: 'effectiveFrom', kind: 'date', required: true },
      { key: 'effectiveTo', kind: 'date' },
    ],
  },
]
