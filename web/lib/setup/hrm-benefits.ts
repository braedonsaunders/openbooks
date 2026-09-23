import type { SetupEntity } from './registry'
import { foldWholeNumber } from './whole-number'

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

/**
 * Pure plan-body shape check (no server imports, so unit tests run it
 * directly like hrm-process-template.ts). The drawer forces prorationBasis
 * with no default; this refuses a missing or unknown rule, unknown bases,
 * non-ISO currency, and negative waiting periods by field name. Org
 * visibility and component-kind proofs stay in validateEntityIntegrity in
 * write.ts, beside the database they need.
 */
export function benefitPlanShapeProblem(body: Record<string, unknown>): string | null {
  const proration = (body.prorationBasis ?? null) as string | null
  if (proration !== 'full_month' && proration !== 'daily') {
    return 'Declare how partial months pay: full_month carries the whole month, daily scales by covered days — the plan cannot save without it'
  }
  for (const side of ['employeeCostBasis', 'employerCostBasis'] as const) {
    const basis = (body[side] ?? null) as string | null
    if (basis !== 'per_period' && basis !== 'per_month' && basis !== 'per_year' && basis !== 'percent_of_pay') {
      return 'Price each side as per_period, per_month, per_year, or percent_of_pay'
    }
  }
  const currency = (body.currency ?? null) as string | null
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) {
    return 'Currency is a 3-letter ISO code in capitals — HR never converts it, the run refuses a mismatch'
  }
  // The text input sends whole numbers as strings: fold first so the
  // refusal below judges the normalized value, never the transport
  // spelling. '30' creates, '' rides absent (the writer nulls it — the
  // field is optional), and '1.5'/'-1'/'abc' ride through to this refusal.
  const waiting = foldWholeNumber(body.waitingPeriodDays)
  if (waiting !== undefined && (!Number.isInteger(waiting) || (waiting as number) < 0)) {
    return 'The waiting period is a non-negative whole number of days'
  }
  return null
}

/**
 * Boundary normalizer for benefit-plan writes (runs in write.ts on create
 * and edit, mirroring normalizeHrmLeavePolicyInput): the waiting-period
 * text input arrives as a string, and the field is optional, so a blank
 * normalizes to null while a clean whole-number string crosses as an
 * integer. Anything else rides through for benefitPlanShapeProblem.
 */
export function normalizeHrmBenefitPlanInput(
  entityKey: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (entityKey !== 'benefit-plans') return body
  if (body.waitingPeriodDays === undefined) return body
  const folded = foldWholeNumber(body.waitingPeriodDays)
  return { ...body, waitingPeriodDays: folded === undefined ? null : folded }
}
