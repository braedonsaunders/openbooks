import type { SetupEntity } from './types'
import { BENEFIT_CONTRIBUTION_ENTITIES } from './hrm-benefit-contributions'
import { foldWholeNumber } from './whole-number'

/** Benefits owns offers and effective-dated elections; contribution children own pricing.
 * Payroll components own tax treatment, remittance and posting. */

export const BENEFIT_PLANS_ENTITY: SetupEntity = {
  key: 'benefit-plans',
  createDestination: { rowParam: 'program', tabKey: 'benefit-contribution-rules' },
  rehomed: true,
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
    { key: 'isActive', kind: 'badge-active' },
  ],
  fields: [
    // Code is identity: editable on create, read-only on edit — rename by
    // deactivating and creating the new code, never by rewriting history.
    { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
    { key: 'name', kind: 'text', required: true },
    // Org-declared kind (health, dental, vision, life, ...): free text,
    // never a closed list — no pack declares plan kinds.
    { key: 'kind', kind: 'text', required: true, helpTextKey: 'fieldHelp.benefitKind' },
    { key: 'providerPartyId', kind: 'ref', ref: 'vendors', helpTextKey: 'fieldHelp.benefitProvider' },
    { key: 'employerSubsidiaryId', kind: 'ref', ref: 'subsidiaries', legalEmployer: true, labelKey: 'fields.legalEmployer', helpTextKey: 'fieldHelp.benefitSubsidiary' },
    { key: 'currency', kind: 'ref', ref: 'benefit-currencies', refScopeField: 'employerSubsidiaryId', required: true, helpTextKey: 'fieldHelp.benefitCurrency' },
    { key: 'waitingPeriodDays', kind: 'integer', min: 0, defaultValue: 0, keepDefault: true, helpTextKey: 'fieldHelp.benefitWaitingPeriod' },
    { key: 'waitingPeriodMonths', kind: 'integer', min: 0, defaultValue: 0, keepDefault: true, helpTextKey: 'benefitContributions.waitingMonthsHint' },
    { key: 'approvalMode', kind: 'select', required: true, defaultValue: 'none', options: [{ value: 'none', labelKey: 'benefitContributions.noApproval' }, { value: 'flows', labelKey: 'benefitContributions.flowsApproval' }], helpTextKey: 'benefitContributions.approvalHint' },
    { key: 'effectiveFrom', kind: 'date', required: true },
    { key: 'effectiveTo', kind: 'date' },
    { key: 'isActive', kind: 'boolean', defaultValue: false, helpTextKey: 'benefitContributions.activationHint' },
  ],
}

/** Validate the offer identity; pricing is declared by contribution rules. */
export function benefitPlanShapeProblem(body: Record<string, unknown>): string | null {
  if (['employeeCostBasis', 'employeeCost', 'employerCostBasis', 'employerCost', 'employeePayComponentId', 'employerPayComponentId', 'prorationBasis', 'pretax', 'requiresApproval'].some((key) => Object.hasOwn(body, key))) return 'Configure pricing in Contributions and enrollment review in Approval policy'

  const currency = (body.currency ?? null) as string | null
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) {
    return 'Currency is a 3-letter ISO code in capitals — HR never converts it, the run refuses a mismatch'
  }
  // The text input sends whole numbers as strings: fold first so the
  // refusal below judges the normalized value, never the transport
  // spelling. Blank means no waiting period; malformed values remain
  // visible to validation rather than becoming a different period.
  const waiting = foldWholeNumber(body.waitingPeriodDays)
  if (waiting !== undefined && (!Number.isInteger(waiting) || (waiting as number) < 0)) {
    return 'The waiting period is a non-negative whole number of days'
  }
  const months = foldWholeNumber(body.waitingPeriodMonths)
  if (months !== undefined && (!Number.isSafeInteger(months) || (months as number) < 0)) return 'The waiting period is a non-negative whole number of calendar months'
  if ((months as number ?? 0) > 0 && (waiting as number ?? 0) > 0) return 'Choose a waiting period in calendar months or days, not both'
  return null
}

/**
 * Boundary normalizer for benefit-plan writes (runs in write.ts on create
 * and edit, mirroring normalizeHrmLeavePolicyInput): the waiting-period
 * text input arrives as a string, and the field is optional, so a blank
 * declares no waiting while a clean whole-number string crosses as an
 * integer. Blank explicitly clears waiting to zero; omitted fields retain
 * their existing value on edit. Malformed values reach the shape refusal.
 */
export function normalizeHrmBenefitPlanInput(
  entityKey: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (entityKey !== 'benefit-plans') return body
  const result = { ...body }
  for (const field of ['waitingPeriodDays', 'waitingPeriodMonths']) {
    if (body[field] === undefined) continue
    const folded = foldWholeNumber(body[field])
    result[field] = folded === undefined ? 0 : folded
  }
  return result
}

/** Guided coverage and savings forms share the authoritative plan fields. */
export function benefitPlanPresentation(kind: 'health' | 'retirement', creating = true): SetupEntity {
  const retirement = kind === 'retirement'
  const identity = ['code', 'name', 'kind', 'providerPartyId', 'employerSubsidiaryId', 'currency']
  const eligibility = ['waitingPeriodDays', 'waitingPeriodMonths', 'approvalMode', 'effectiveFrom', 'effectiveTo', 'isActive']
  return {
    ...BENEFIT_PLANS_ENTITY,
    formDescriptionKey: `benefitBuilder.${kind}.offer`,
    formSections: creating ? undefined : [
      { titleKey: 'benefitBuilder.offer', fields: identity },
      { titleKey: 'benefitBuilder.eligibility', descriptionKey: 'benefitBuilder.eligibilityHint', fields: eligibility },
    ],
    recordChildren: BENEFIT_CONTRIBUTION_ENTITIES.filter((child) => child.parentRecords?.some((owner) => owner.entityKey === 'benefit-plans') && (retirement || child.key !== 'benefit-contribution-tiers')).map((child) => ({
      ...child,
      titleKey: child.key === 'benefit-contribution-rules' ? `benefitBuilder.${kind}.contribution` : !retirement && child.key === 'benefit-contribution-classes' ? 'benefitBuilder.health.classes' : undefined,
      singularTitleKey: child.key === 'benefit-contribution-rules' ? `benefitBuilder.${kind}.contributionSingular` : undefined,
      fields: child.fields.map((field) => child.key === 'benefit-contribution-rules' && field.key === 'rate'
        ? { ...field, labelKey: `benefitBuilder.${kind}.rate` }
        : !retirement && ['rateFormula', 'matchRuleId', 'requiresMatchEligibility', 'enforcePolicyCap'].includes(field.key)
          ? { ...field, sectionKey: 'sections.benefitAdvanced' } : field),
    })),
    singularTitleKey: `benefitBuilder.${kind}.title`,
    creationSteps: [
      { key: 'offer', titleKey: 'benefitBuilder.offer', descriptionKey: `benefitBuilder.${kind}.offer`, fields: identity },
      { key: 'eligibility', titleKey: 'benefitBuilder.eligibility', descriptionKey: 'benefitBuilder.eligibilityHint', fields: eligibility },
    ],
    fields: BENEFIT_PLANS_ENTITY.fields.map((field) => {
      if (field.key === 'isActive') return { ...field, hidden: creating }
      if (field.key === 'kind') return { ...field, defaultValue: kind, ...(retirement ? { hidden: true } : { labelKey: 'benefitBuilder.coverageType' }) }
      if (field.key === 'providerPartyId') return { ...field, labelKey: `benefitBuilder.${kind}.provider` }
      if (field.key === 'currency') return { ...field, ref: 'benefit-currencies', refScopeField: 'employerSubsidiaryId' }
      return { ...field, sectionKey: undefined }
    }),
  }
}
