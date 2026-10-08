import type { SetupEntity, SetupOption } from './types'

const options = (group: string, values: string[]): SetupOption[] => values.map((value) => ({ value, labelKey: `benefitContributions.options.${group}.${value}` }))
const parent = [{ entityKey: 'benefit-plans', fieldKey: 'planId' }]
const planField = { key: 'planId', kind: 'ref' as const, ref: 'benefit-plans', required: true }
const common = { groupKey: 'workforce', featureKey: 'hrm', rehomed: true, orgScoped: true, actorCols: true, writePermission: 'hrm.benefits.manage', iconKey: 'heart-pulse' }

/** Typed contribution terms are the sole recurring-benefit pricing authority. */
export const BENEFIT_CONTRIBUTION_ENTITIES: SetupEntity[] = [
  {
    ...common, key: 'benefit-contribution-rules', table: 'hrm_benefit_contribution_rules', parentRecords: parent,
    hasActive: true, orderBy: 'position',
    columns: [{ key: 'name', kind: 'text' }, { key: 'kind', labelKey: 'benefitContributions.fields.kind', kind: 'badge', options: options('kind', ['employee_deduction', 'employer_contribution', 'taxable_non_cash', 'cash_earning']) }, { key: 'basis', labelKey: 'benefitContributions.fields.basis', kind: 'badge', options: options('basis', ['per_hour', 'per_period', 'per_month', 'per_year', 'percent_of_eligible_pay']) }, { key: 'rate', labelKey: 'benefitContributions.fields.rate', kind: 'number' }, { key: 'effectiveFrom', kind: 'date' }, { key: 'isActive', kind: 'badge-active' }],
    fields: [planField,
      { key: 'ruleKey', labelKey: 'benefitContributions.fields.ruleKey', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      { key: 'kind', labelKey: 'benefitContributions.fields.kind', kind: 'select', required: true, options: options('kind', ['employee_deduction', 'employer_contribution', 'taxable_non_cash', 'cash_earning']), helpTextKey: 'benefitContributions.componentHint' },
      { key: 'payComponentId', labelKey: 'benefitContributions.fields.payComponentId', kind: 'ref', ref: 'pay-components', required: true, helpTextKey: 'benefitContributions.componentHint' },
      { key: 'basis', labelKey: 'benefitContributions.fields.basis', kind: 'select', required: true, options: options('basis', ['per_hour', 'per_period', 'per_month', 'per_year', 'percent_of_eligible_pay']) },
      { key: 'rateFormula', kind: 'select', required: true, options: options('formula', ['elected_rate', 'hourly_wage_percent', 'matching_election']), helpTextKey: 'benefitContributions.formulaHint' },
      { key: 'rate', labelKey: 'benefitContributions.fields.rate', kind: 'decimal', required: true, helpTextKey: 'benefitContributions.rateHint' },
      { key: 'hoursBasis', kind: 'select', required: true, options: options('hours', ['all_paid', 'regular_paid', 'scheduled_paid', 'selected_components']), showWhen: { field: 'basis', in: ['per_hour'] } },
      { key: 'hoursCoverage', kind: 'select', required: true, defaultValue: 'earned_dates', labelKey: 'benefitContributions.hoursCoverage', options: options('hoursCoverage', ['earned_dates', 'pay_period_end']), helpTextKey: 'benefitContributions.hoursCoverageHint' },
      { key: 'payBasis', kind: 'select', required: true, options: options('pay', ['all_cash_earnings', 'regular_cash_earnings']), showWhen: { field: 'basis', in: ['percent_of_eligible_pay'] } },
      { key: 'monthsPerYear', kind: 'integer', required: true, min: 1, max: 12, showWhen: { field: 'basis', in: ['per_month'] } },
      { key: 'periodsPerYear', kind: 'integer', min: 1, max: 366, helpTextKey: 'benefitContributions.annualizationHint', showWhen: { field: 'basis', in: ['per_month', 'per_year'] } },
      { key: 'proration', kind: 'select', required: true, options: options('proration', ['none', 'calendar_days']) },
      { key: 'matchRuleId', kind: 'ref', required: true, ref: 'benefit-contribution-rules', refScopeField: 'planId', showWhen: { field: 'rateFormula', in: ['matching_election'] } },
      { key: 'requiresMatchEligibility', kind: 'boolean', defaultValue: false },
      { key: 'enforcePolicyCap', kind: 'boolean', defaultValue: false, helpTextKey: 'benefitContributions.capHint' },
      { key: 'runApplicability', kind: 'select', required: true, options: options('run', ['regular_only', 'all_pay_runs']) },
      { key: 'unpaidPeriodTreatment', kind: 'select', required: true, options: options('unpaid', ['charge', 'carry']) },
      { key: 'arrearsPlanId', kind: 'ref', ref: 'entitlement-plans', helpTextKey: 'benefitContributions.arrearsHint', showWhen: { field: 'unpaidPeriodTreatment', in: ['carry'] } },
      { key: 'arrearsRecoveryPeriods', kind: 'integer', min: 1, max: 52, helpTextKey: 'benefitContributions.arrearsHint', showWhen: { field: 'unpaidPeriodTreatment', in: ['carry'] } },
      { key: 'position', kind: 'integer', required: true, defaultValue: 0 },
      { key: 'effectiveFrom', kind: 'date', required: true }, { key: 'effectiveTo', kind: 'date' },
      { key: 'isActive', kind: 'boolean', defaultValue: true },
    ],
  },
  {
    // Counted earning components behind a per-hour selected-components rule.
    // One row per (rule, component); the write validator refuses non-earning
    // components and duplicates, and plan activation refuses an empty list.
    ...common, key: 'benefit-contribution-rule-components', singularTitleKey: 'entities.benefit-contribution-rule-components.singular', table: 'hrm_benefit_contribution_rule_components', parentRecords: [{ entityKey: 'benefit-contribution-rules', fieldKey: 'ruleId' }],
    hasActive: false, orderBy: 'id',
    columns: [{ key: 'ruleId', labelKey: 'benefitContributions.fields.ruleId', kind: 'ref', ref: 'benefit-contribution-rules' }, { key: 'payComponentId', labelKey: 'benefitContributions.fields.payComponentId', kind: 'ref', ref: 'pay-components' }],
    fields: [planField,
      { key: 'ruleId', labelKey: 'benefitContributions.fields.ruleId', kind: 'ref', ref: 'benefit-contribution-rules', refScopeField: 'planId', required: true, helpTextKey: 'benefitContributions.countedComponentsHint' },
      { key: 'payComponentId', labelKey: 'benefitContributions.fields.payComponentId', kind: 'ref', ref: 'pay-components', required: true, helpTextKey: 'benefitContributions.countedComponentsHint' }],
  },
  {
    ...common, key: 'benefit-recovery-sources', table: 'hrm_benefit_recovery_sources', parentRecords: parent,
    hasActive: false, orderBy: 'id',
    columns: [{ key: 'ruleId', labelKey: 'benefitContributions.fields.recoveryRuleId', kind: 'ref', ref: 'benefit-contribution-rules' }, { key: 'premiumRuleId', labelKey: 'benefitContributions.fields.premiumRuleId', kind: 'ref', ref: 'benefit-contribution-rules' }],
    fields: [planField,
      { key: 'ruleId', labelKey: 'benefitContributions.fields.recoveryRuleId', kind: 'ref', ref: 'benefit-recovery-deduction-rules', refScopeField: 'planId', required: true, helpTextKey: 'benefitContributions.recoverySourceHint' },
      { key: 'premiumRuleId', labelKey: 'benefitContributions.fields.premiumRuleId', kind: 'ref', ref: 'benefit-recovery-premium-rules', refScopeField: 'planId', required: true, helpTextKey: 'benefitContributions.recoverySourceHint' }],
  },
  {
    ...common, key: 'benefit-contribution-classes', table: 'hrm_benefit_contribution_classes', parentRecords: parent,
    hasActive: false, orderBy: 'name', refValue: 'classKey',
    columns: [{ key: 'classKey', kind: 'code' }, { key: 'name', kind: 'text' }],
    fields: [planField, { key: 'classKey', kind: 'text', required: true, lockedOnEdit: true }, { key: 'name', kind: 'text', required: true }],
  },
  {
    ...common, key: 'benefit-contribution-tiers', table: 'hrm_benefit_contribution_tiers', parentRecords: parent,
    hasActive: false, orderBy: 'minimum_service_years',
    columns: [{ key: 'classKey', kind: 'ref', ref: 'benefit-contribution-classes' }, { key: 'minimumServiceYears', kind: 'number' }, { key: 'employerMaxPercent', kind: 'percent' }, { key: 'employeeMatchRatio', kind: 'number' }, { key: 'effectiveFrom', kind: 'date' }, { key: 'effectiveTo', kind: 'date' }],
    fields: [planField, { key: 'classKey', kind: 'ref', ref: 'benefit-contribution-classes', refScopeField: 'planId', required: true },
      { key: 'minimumServiceYears', kind: 'integer', min: 0, required: true },
      { key: 'employerMaxPercent', kind: 'percent', min: 0, max: 100, required: true, helpTextKey: 'benefitContributions.capHint' },
      { key: 'employeeMatchRatio', kind: 'decimal', required: true, helpTextKey: 'benefitContributions.ratioHint' },
      { key: 'effectiveFrom', kind: 'date', required: true }, { key: 'effectiveTo', kind: 'date' }],
  },
  {
    ...common, key: 'benefit-enrollment-configuration', table: 'hrm_benefit_enrollments',
    singularTitleKey: 'entities.benefit-enrollment-configuration.singular', hasActive: false, allowCreate: false, allowDelete: false,
    columns: [{ key: 'planId', kind: 'ref', ref: 'benefit-plans' }, { key: 'effectiveFrom', kind: 'date' }],
    fields: [{ key: 'employmentId', kind: 'ref', ref: 'worker-employments', lockedOnEdit: true, hidden: true }, { key: 'planId', kind: 'ref', ref: 'benefit-plans', lockedOnEdit: true },
      { key: 'classKey', kind: 'ref', ref: 'benefit-contribution-classes', refScopeField: 'planId', helpTextKey: 'benefitContributions.classHint' },
      { key: 'matchEligible', kind: 'boolean', helpTextKey: 'benefitContributions.matchHint' }],
  },
  {
    ...common, key: 'benefit-enrollment-terms', table: 'hrm_benefit_enrollment_terms',
    parentRecords: [{ entityKey: 'benefit-enrollment-configuration', fieldKey: 'enrollmentId' }], hasActive: false, orderBy: 'effective_from',
    columns: [{ key: 'ruleId', labelKey: 'benefitContributions.fields.ruleId', kind: 'ref', ref: 'benefit-contribution-rules' }, { key: 'electionMode', kind: 'badge', options: options('election', ['fixed', 'follows_policy']) }, { key: 'electedRate', kind: 'number' }, { key: 'effectiveFrom', kind: 'date' }, { key: 'effectiveTo', kind: 'date' }],
    fields: [{ key: 'enrollmentId', kind: 'ref', ref: 'benefit-enrollment-configuration', required: true },
      { key: 'ruleId', labelKey: 'benefitContributions.fields.ruleId', kind: 'ref', ref: 'benefit-enrollment-rules', refScopeField: 'enrollmentId', required: true },
      { key: 'electionMode', kind: 'select', required: true, options: options('election', ['fixed', 'follows_policy']), helpTextKey: 'benefitContributions.electionHint' },
      { key: 'electedRate', kind: 'decimal', showWhen: { field: 'electionMode', in: ['fixed'] }, helpTextKey: 'benefitContributions.electedRateHint' },
      { key: 'declaredPeriodsPerYear', kind: 'integer', min: 1, max: 366, helpTextKey: 'benefitContributions.annualizationHint' },
      { key: 'effectiveFrom', kind: 'date', required: true }, { key: 'effectiveTo', kind: 'date' }],
  },
]

export const BENEFIT_ENROLLMENT_CONFIGURATION_ENTITY = BENEFIT_CONTRIBUTION_ENTITIES.find((entity) => entity.key === 'benefit-enrollment-configuration')!
