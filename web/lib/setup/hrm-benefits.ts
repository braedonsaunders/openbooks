import type { SetupEntity } from './registry'

/**
 * Setup-registry descriptors for HRM benefit plans and pricing tiers (0197).
 *
 * Both are ordinary registry entities behind the hrm switch and MUST be
 * spread into SETUP_ENTITIES in registry.ts — that wires the generic list
 * view (admin/setup/[entity]), the create/edit drawer, and the generic CRUD
 * API (api/admin/setup/[entity]).
 *
 * What these screens are, and are NOT:
 *
 * They are NOT payroll. Plans name what the org offers (health, dental,
 * retirement, ...) with the org's own cost figures and proration rule, and
 * tiers price coverage levels (employee-only, family, ...). Tax treatment
 * lives on the linked pay components (pay_components.tax_treatment) and is
 * never declared here; the run prices the amounts HR sends. Amounts on an
 * election are copied from the plan/tier at elect time — repricing here
 * never rewrites history.
 *
 * No raw JSON: tiers are an ordered child entity (0193 steps precedent),
 * never a jsonb column. prorationBasis carries NO default — a silent
 * default would guess what a partial month pays; the drawer forces the
 * choice and the write path refuses a missing one by name.
 */

const COST_BASES = [
  { value: 'per_period', labelKey: 'options.benefitCostBasis.per_period' },
  { value: 'per_month', labelKey: 'options.benefitCostBasis.per_month' },
  { value: 'per_year', labelKey: 'options.benefitCostBasis.per_year' },
  { value: 'percent_of_pay', labelKey: 'options.benefitCostBasis.percent_of_pay' },
]

const PRORATION_BASES = [
  { value: 'full_month', labelKey: 'options.benefitProrationBasis.full_month' },
  { value: 'daily', labelKey: 'options.benefitProrationBasis.daily' },
]

export const BENEFIT_PLANS_ENTITY: SetupEntity = {
  key: 'benefit-plans',
  table: 'hrm_benefit_plans',
  groupKey: 'workforce',
  featureKey: 'hrm',
  iconKey: 'heart-pulse',
  orgScoped: true,
  actorCols: true,
  naturalKey: 'code',
  hasActive: true,
  docSlug: 'benefits-enrollment',
  columns: [
    { key: 'code', kind: 'code' },
    { key: 'name', kind: 'text' },
    { key: 'kind', kind: 'text' },
    { key: 'currency', kind: 'code' },
    { key: 'employeeCostBasis', kind: 'badge', options: COST_BASES },
    { key: 'isActive', kind: 'badge-active' },
  ],
  filters: [{ key: 'employeeCostBasis', options: COST_BASES }],
  fields: [
    // Code is identity: editable on create, read-only on edit — rename by
    // deactivating and creating the new code, never by rewriting history.
    { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
    { key: 'name', kind: 'text', required: true },
    // Org-declared kind (health, dental, vision, life, ...): free text,
    // never a closed list — no pack declares plan kinds.
    { key: 'kind', kind: 'text', required: true, helpTextKey: 'fieldHelp.benefitKind' },
    { key: 'providerPartyId', kind: 'ref', ref: 'vendors', helpTextKey: 'fieldHelp.benefitProvider' },
    { key: 'employerSubsidiaryId', kind: 'ref', ref: 'subsidiaries', helpTextKey: 'fieldHelp.benefitSubsidiary' },
    { key: 'currency', kind: 'ref', ref: 'currencies', required: true, helpTextKey: 'fieldHelp.benefitCurrency' },
    {
      key: 'employeeCostBasis', kind: 'select', required: true, options: COST_BASES,
      sectionKey: 'sections.benefitCosts', helpTextKey: 'fieldHelp.benefitCostBasis',
    },
    { key: 'employeeCost', kind: 'decimal', sectionKey: 'sections.benefitCosts', helpTextKey: 'fieldHelp.benefitCost' },
    {
      key: 'employerCostBasis', kind: 'select', required: true, options: COST_BASES,
      sectionKey: 'sections.benefitCosts', helpTextKey: 'fieldHelp.benefitCostBasis',
    },
    { key: 'employerCost', kind: 'decimal', sectionKey: 'sections.benefitCosts', helpTextKey: 'fieldHelp.benefitCost' },
    { key: 'pretax', kind: 'boolean', sectionKey: 'sections.benefitCosts', helpTextKey: 'fieldHelp.benefitPretax' },
    // No defaultValue on purpose: the drawer forces an explicit choice and
    // the write path refuses a missing rule by name (0197: no silent default).
    {
      key: 'prorationBasis', kind: 'select', required: true, options: PRORATION_BASES,
      sectionKey: 'sections.benefitCosts', helpTextKey: 'fieldHelp.benefitProrationBasis',
    },
    {
      key: 'employeePayComponentId', kind: 'ref', ref: 'pay-components',
      sectionKey: 'sections.benefitComponents', helpTextKey: 'fieldHelp.benefitEmployeeComponent',
    },
    {
      key: 'employerPayComponentId', kind: 'ref', ref: 'pay-components',
      sectionKey: 'sections.benefitComponents', helpTextKey: 'fieldHelp.benefitEmployerComponent',
    },
    { key: 'waitingPeriodDays', kind: 'integer', helpTextKey: 'fieldHelp.benefitWaitingPeriod' },
    { key: 'requiresApproval', kind: 'boolean', helpTextKey: 'fieldHelp.benefitRequiresApproval' },
    { key: 'effectiveFrom', kind: 'date', required: true },
    { key: 'effectiveTo', kind: 'date' },
    { key: 'isActive', kind: 'boolean', defaultValue: true },
  ],
}

export const BENEFIT_PLAN_LEVELS_ENTITY: SetupEntity = {
  key: 'benefit-plan-levels',
  table: 'hrm_benefit_plan_levels',
  groupKey: 'workforce',
  featureKey: 'hrm',
  iconKey: 'layers',
  orgScoped: true,
  actorCols: true,
  orderBy: 'position',
  hasActive: false,
  docSlug: 'benefits-enrollment',
  columns: [
    { key: 'planId', kind: 'ref', ref: 'benefit-plans' },
    { key: 'levelKey', kind: 'code' },
    { key: 'label', kind: 'text' },
    { key: 'employeeCost', kind: 'number' },
    { key: 'employerCost', kind: 'number' },
  ],
  fields: [
    { key: 'planId', kind: 'ref', ref: 'benefit-plans', required: true },
    { key: 'levelKey', kind: 'text', required: true, helpTextKey: 'fieldHelp.benefitLevelKey' },
    { key: 'label', kind: 'text', required: true },
    { key: 'employeeCost', kind: 'decimal', required: true },
    { key: 'employerCost', kind: 'decimal', required: true },
    { key: 'position', kind: 'integer', required: true },
  ],
}
