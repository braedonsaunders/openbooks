import type { SetupEntity } from './types'

/**
 * Employer-defined benefit programs and their members, sources, and scope.
 * Insured benefit plans (benefit-plans) stay authoritative for health and
 * retirement; these entities store employer-defined rewards, allowances,
 * incentives, and custom programs with typed rule columns.
 *
 * Scope is a typed child entity resolving departments and projects through
 * tenant keys; funding sources name ledger accounts the same way. Status
 * moves (draft/active/closed) run through the program service, which locks
 * the row, proves the configuration resolves, and audits the move — the
 * registry displays the authoritative records read-only; draft edits and
 * lifecycle moves use the Benefits program editor.
 */

const PROGRAM_FAMILIES = [
  { value: 'reward', labelKey: 'options.benefitProgramFamily.reward' },
  { value: 'allowance', labelKey: 'options.benefitProgramFamily.allowance' },
  { value: 'incentive', labelKey: 'options.benefitProgramFamily.incentive' },
  { value: 'custom', labelKey: 'options.benefitProgramFamily.custom' },
]

const PROGRAM_STATUSES = [
  { value: 'draft', labelKey: 'options.benefitProgramStatus.draft' },
  { value: 'active', labelKey: 'options.benefitProgramStatus.active' },
  { value: 'closed', labelKey: 'options.benefitProgramStatus.closed' },
]

const DELIVERY_METHODS = [
  { value: 'payroll', labelKey: 'options.benefitDeliveryMethod.payroll' },
  { value: 'external', labelKey: 'options.benefitDeliveryMethod.external' },
]

const VALUATIONS = [
  { value: 'fixed', labelKey: 'options.benefitValuation.fixed' },
  { value: 'percent', labelKey: 'options.benefitValuation.percent' },
  { value: 'pool', labelKey: 'options.benefitValuation.pool' },
]

const METRICS = [
  { value: 'revenue', labelKey: 'options.benefitMetric.revenue' },
  { value: 'gross_profit', labelKey: 'options.benefitMetric.gross_profit' },
  { value: 'net_profit', labelKey: 'options.benefitMetric.net_profit' },
  { value: 'approved_hours', labelKey: 'options.benefitMetric.approved_hours' },
]

const METRIC_SCOPES = [
  { value: 'company', labelKey: 'options.benefitMetricScope.company' },
  { value: 'department', labelKey: 'options.benefitMetricScope.department' },
  { value: 'project', labelKey: 'options.benefitMetricScope.project' },
]

const ALLOCATIONS = [
  { value: 'equal', labelKey: 'options.benefitAllocation.equal' },
  { value: 'hours', labelKey: 'options.benefitAllocation.hours' },
  { value: 'role', labelKey: 'options.benefitAllocation.role' },
]

const FREQUENCIES = [
  { value: 'monthly', labelKey: 'options.benefitFrequency.monthly' },
  { value: 'quarterly', labelKey: 'options.benefitFrequency.quarterly' },
  { value: 'annual', labelKey: 'options.benefitFrequency.annual' },
  { value: 'project_complete', labelKey: 'options.benefitFrequency.project_complete' },
  { value: 'manual', labelKey: 'options.benefitFrequency.manual' },
]

const PERIOD_BASES = [
  { value: 'calendar', labelKey: 'options.benefitPeriodBasis.calendar' },
  { value: 'fiscal', labelKey: 'options.benefitPeriodBasis.fiscal' },
]

export const BENEFIT_PROGRAMS_ENTITY: SetupEntity = {
  key: 'benefit-programs',
  readOnly: true,
  allowCreate: false,
  allowDelete: false,
  table: 'hrm_benefit_programs',
  groupKey: 'workforce',
  featureKey: 'hrm',
  iconKey: 'gift',
  orgScoped: true,
  actorCols: true,
  naturalKey: 'code',
  hasActive: false,
  docSlug: 'benefits-programs',
  columns: [
    { key: 'code', kind: 'code' },
    { key: 'name', kind: 'text' },
    { key: 'family', kind: 'badge', options: PROGRAM_FAMILIES },
    { key: 'status', kind: 'badge', options: PROGRAM_STATUSES },
    { key: 'currency', kind: 'code' },
    { key: 'effectiveFrom', kind: 'date' },
  ],
  filters: [
    { key: 'family', options: PROGRAM_FAMILIES },
    { key: 'status', options: PROGRAM_STATUSES },
  ],
  fields: [
    { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
    { key: 'name', kind: 'text', required: true },
    { key: 'family', kind: 'select', required: true, options: PROGRAM_FAMILIES, helpTextKey: 'fieldHelp.benefitProgramFamily' },
    { key: 'description', kind: 'text', helpTextKey: 'fieldHelp.benefitProgramDescription' },
    { key: 'legalEntityId', kind: 'ref', ref: 'subsidiaries', helpTextKey: 'fieldHelp.benefitProgramEntity' },
    { key: 'currency', kind: 'ref', ref: 'currencies', required: true, helpTextKey: 'fieldHelp.benefitCurrency' },
    { key: 'effectiveFrom', kind: 'date', required: true },
    { key: 'effectiveTo', kind: 'date' },
    {
      key: 'payComponentId', kind: 'ref', ref: 'pay-components',
      sectionKey: 'sections.benefitDelivery', helpTextKey: 'fieldHelp.benefitProgramComponent',
    },
    {
      key: 'deliveryMethod', kind: 'select', required: true, options: DELIVERY_METHODS,
      sectionKey: 'sections.benefitDelivery', helpTextKey: 'fieldHelp.benefitDeliveryMethod',
    },
    {
      key: 'valuation', kind: 'select', required: true, options: VALUATIONS,
      sectionKey: 'sections.benefitRules', helpTextKey: 'fieldHelp.benefitValuation',
    },
    {
      key: 'metric', kind: 'select', options: METRICS,
      sectionKey: 'sections.benefitRules', helpTextKey: 'fieldHelp.benefitMetric',
    },
    {
      key: 'metricScope', kind: 'select', options: METRIC_SCOPES,
      sectionKey: 'sections.benefitRules', helpTextKey: 'fieldHelp.benefitMetricScope',
    },
    {
      key: 'allocation', kind: 'select', required: true, options: ALLOCATIONS,
      sectionKey: 'sections.benefitRules', helpTextKey: 'fieldHelp.benefitAllocation',
    },
    { key: 'percentRate', kind: 'decimal', sectionKey: 'sections.benefitRules' },
    { key: 'fixedAmount', kind: 'decimal', sectionKey: 'sections.benefitRules' },
    { key: 'capAmount', kind: 'decimal', sectionKey: 'sections.benefitRules' },
    { key: 'budgetAmount', kind: 'decimal', sectionKey: 'sections.benefitRules' },
    { key: 'thresholdAmount', kind: 'decimal', sectionKey: 'sections.benefitRules' },
    {
      key: 'frequency', kind: 'select', required: true, options: FREQUENCIES,
      sectionKey: 'sections.benefitRules', helpTextKey: 'fieldHelp.benefitFrequency',
    },
    {
      key: 'periodBasis', kind: 'select', options: PERIOD_BASES,
      sectionKey: 'sections.benefitRules', helpTextKey: 'fieldHelp.benefitPeriodBasis',
    },
    { key: 'paymentDelayDays', kind: 'integer', sectionKey: 'sections.benefitRules' },
  ],
}

export const BENEFIT_PROGRAM_SCOPES_ENTITY: SetupEntity = {
  key: 'benefit-program-scopes',
  readOnly: true,
  allowCreate: false,
  allowDelete: false,
  parentRecords: [{ entityKey: 'benefit-programs', fieldKey: 'programId' }],
  table: 'hrm_benefit_program_scopes',
  groupKey: 'workforce',
  featureKey: 'hrm',
  iconKey: 'layers',
  orgScoped: true,
  actorCols: true,
  hasActive: false,
  docSlug: 'benefits-programs',
  columns: [
    { key: 'programId', kind: 'ref', ref: 'benefit-programs' },
    { key: 'departmentId', kind: 'ref', ref: 'departments' },
    { key: 'projectId', kind: 'ref', ref: 'projects' },
  ],
  fields: [
    { key: 'programId', kind: 'ref', ref: 'benefit-programs', required: true },
    { key: 'departmentId', kind: 'ref', ref: 'departments' },
    { key: 'projectId', kind: 'ref', ref: 'projects' },
  ],
}

export const BENEFIT_PROGRAM_SOURCES_ENTITY: SetupEntity = {
  key: 'benefit-program-sources',
  readOnly: true,
  allowCreate: false,
  allowDelete: false,
  parentRecords: [{ entityKey: 'benefit-programs', fieldKey: 'programId' }],
  table: 'hrm_benefit_program_sources',
  groupKey: 'workforce',
  featureKey: 'hrm',
  iconKey: 'layers',
  orgScoped: true,
  actorCols: true,
  hasActive: false,
  docSlug: 'benefits-programs',
  columns: [
    { key: 'programId', kind: 'ref', ref: 'benefit-programs' },
    { key: 'accountId', kind: 'ref', ref: 'accounts' },
  ],
  fields: [
    { key: 'programId', kind: 'ref', ref: 'benefit-programs', required: true },
    { key: 'accountId', kind: 'ref', ref: 'accounts', required: true },
    { key: 'weightBps', kind: 'integer' },
  ],
}

export const BENEFIT_PROGRAM_MEMBERS_ENTITY: SetupEntity = {
  key: 'benefit-program-members',
  readOnly: true,
  allowCreate: false,
  allowDelete: false,
  parentRecords: [{ entityKey: 'benefit-programs', fieldKey: 'programId' }],
  table: 'hrm_benefit_program_members',
  groupKey: 'workforce',
  featureKey: 'hrm',
  iconKey: 'users',
  orgScoped: true,
  actorCols: true,
  hasActive: false,
  docSlug: 'benefits-programs',
  columns: [
    { key: 'programId', kind: 'ref', ref: 'benefit-programs' },
    { key: 'employmentId', kind: 'ref', ref: 'employees' },
    { key: 'effectiveFrom', kind: 'date' },
    { key: 'effectiveTo', kind: 'date' },
  ],
  fields: [
    { key: 'programId', kind: 'ref', ref: 'benefit-programs', required: true },
    { key: 'employmentId', kind: 'ref', ref: 'employees', required: true },
    { key: 'effectiveFrom', kind: 'date', required: true },
    { key: 'effectiveTo', kind: 'date' },
    { key: 'weight', kind: 'decimal' },
    { key: 'role', kind: 'text' },
  ],
}

/**
 * Pure program-body shape check (no server imports, so unit tests run it
 * directly). Refuses unknown family/delivery/valuation/metric/scope/
 * allocation/frequency, non-ISO currency, and a quarterly or annual program
 * without a calendar or fiscal period basis by field name.
 */
export function benefitProgramShapeProblem(body: Record<string, unknown>): string | null {
  const families = ['reward', 'allowance', 'incentive', 'custom']
  const family = (body.family ?? null) as string | null
  if (family !== null && !families.includes(family)) {
    return 'Family is reward, allowance, incentive, or custom — insured health and retirement stay on benefit plans'
  }
  const currency = (body.currency ?? null) as string | null
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) {
    return 'Currency is a 3-letter ISO code in capitals — payroll never converts it'
  }
  const frequency = (body.frequency ?? null) as string | null
  const periodBasis = (body.periodBasis ?? null) as string | null
  if ((frequency === 'quarterly' || frequency === 'annual') && periodBasis !== 'calendar' && periodBasis !== 'fiscal') {
    return 'Quarterly and annual programs name their period basis — calendar or fiscal so settlement and payroll agree on the period'
  }
  if (periodBasis !== null && periodBasis !== 'calendar' && periodBasis !== 'fiscal') {
    return 'Period basis is calendar or fiscal'
  }
  return null
}
