import type { SetupEntity } from './registry'

/**
 * HR-13 construction-compliance Setup entities. All five live rehomed on
 * the Compliance page (SetupEntitySection), never on the setup rail — one
 * configurable surface, never two. Scalar fields only: rule bodies
 * (per-diem rules, comp match shapes, schedule scope) are validated
 * structures edited through the Compliance page and the API, never raw
 * JSON registry fields.
 */

const SCHEDULE_KINDS = [
  { value: 'prevailing_wage', labelKey: 'options.hrmScheduleKind.prevailingWage' },
  { value: 'union_agreement', labelKey: 'options.hrmScheduleKind.unionAgreement' },
  { value: 'org_declared', labelKey: 'options.hrmScheduleKind.orgDeclared' },
]

const RECIPROCITY = [
  { value: 'home_local', labelKey: 'options.hrmReciprocity.homeLocal' },
  { value: 'jobsite_local', labelKey: 'options.hrmReciprocity.jobsiteLocal' },
  { value: 'higher_of', labelKey: 'options.hrmReciprocity.higherOf' },
]

const PER_DIEM_BASES = [
  { value: 'flat_daily', labelKey: 'options.hrmPerDiemBasis.flatDaily' },
  { value: 'distance_brackets', labelKey: 'options.hrmPerDiemBasis.distanceBrackets' },
  { value: 'hours_threshold', labelKey: 'options.hrmPerDiemBasis.hoursThreshold' },
]

export const CONSTRUCTION_CLASSIFICATIONS_ENTITY: SetupEntity = {
  key: 'construction-classifications',
  table: 'hrm_work_classifications',
  groupKey: 'workforce',
  featureKey: 'hrmConstructionCompliance',
  rehomed: true, // section on the HRM Compliance page
  rehomedTo: '/hrm/compliance',
  iconKey: 'hard-hat',
  orgScoped: true,
  actorCols: true,
  naturalKey: 'code',
  hasActive: true,
  docSlug: 'certified-payroll-prevailing-wage-per-diem',
  columns: [
    { key: 'code', kind: 'code' },
    { key: 'name', kind: 'text' },
    { key: 'trade', kind: 'text' },
    { key: 'isApprentice', kind: 'badge-active' },
    { key: 'isActive', kind: 'badge-active' },
  ],
  fields: [
    { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
    { key: 'name', kind: 'text', required: true },
    { key: 'trade', kind: 'text', required: true },
    { key: 'isApprentice', kind: 'boolean' },
    { key: 'apprenticeProgramRef', kind: 'text' },
    { key: 'journeyClassificationId', kind: 'ref', ref: 'construction-classifications' },
  ],
}

export const CONSTRUCTION_RATE_SCHEDULES_ENTITY: SetupEntity = {
  key: 'construction-rate-schedules',
  table: 'hrm_rate_schedules',
  groupKey: 'workforce',
  featureKey: 'hrmConstructionCompliance',
  rehomed: true, // section on the HRM Compliance page
  rehomedTo: '/hrm/compliance',
  iconKey: 'table-properties',
  orgScoped: true,
  actorCols: true,
  naturalKey: 'name',
  hasActive: true,
  docSlug: 'certified-payroll-prevailing-wage-per-diem',
  columns: [
    { key: 'name', kind: 'text' },
    { key: 'kind', kind: 'badge', options: SCHEDULE_KINDS },
    { key: 'reciprocity', kind: 'badge', options: RECIPROCITY },
    { key: 'isActive', kind: 'badge-active' },
  ],
  filters: [{ key: 'kind', options: SCHEDULE_KINDS }],
  fields: [
    { key: 'name', kind: 'text', required: true },
    { key: 'kind', kind: 'select', required: true, options: SCHEDULE_KINDS },
    { key: 'sourceRef', kind: 'text', helpTextKey: 'fieldHelp.rateScheduleSource' },
    { key: 'jurisdictionCode', kind: 'text', helpTextKey: 'fieldHelp.rateScheduleJurisdiction' },
    { key: 'reciprocity', kind: 'select', required: true, options: RECIPROCITY },
    { key: 'effectiveFrom', kind: 'date', required: true },
    { key: 'effectiveTo', kind: 'date' },
  ],
}

export const CONSTRUCTION_COMP_CLASSES_ENTITY: SetupEntity = {
  key: 'construction-comp-classes',
  table: 'hrm_comp_classes',
  groupKey: 'workforce',
  featureKey: 'hrmConstructionCompliance',
  rehomed: true, // section on the HRM Compliance page
  rehomedTo: '/hrm/compliance',
  iconKey: 'shield-plus',
  orgScoped: true,
  actorCols: true,
  naturalKey: 'code',
  hasActive: true,
  docSlug: 'certified-payroll-prevailing-wage-per-diem',
  columns: [
    { key: 'code', kind: 'code' },
    { key: 'name', kind: 'text' },
    { key: 'ratePer100', kind: 'number' },
    { key: 'isActive', kind: 'badge-active' },
  ],
  fields: [
    { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
    { key: 'name', kind: 'text', required: true },
    { key: 'jurisdictionCode', kind: 'text' },
    { key: 'ratePer100', kind: 'decimal' },
    { key: 'effectiveFrom', kind: 'date', required: true },
    { key: 'effectiveTo', kind: 'date' },
  ],
}

export const CONSTRUCTION_PER_DIEM_POLICIES_ENTITY: SetupEntity = {
  key: 'construction-per-diem-policies',
  table: 'hrm_per_diem_policies',
  groupKey: 'workforce',
  featureKey: 'hrmConstructionCompliance',
  rehomed: true, // section on the HRM Compliance page
  rehomedTo: '/hrm/compliance',
  iconKey: 'wallet',
  orgScoped: true,
  actorCols: true,
  naturalKey: 'name',
  hasActive: true,
  docSlug: 'certified-payroll-prevailing-wage-per-diem',
  columns: [
    { key: 'name', kind: 'text' },
    { key: 'basis', kind: 'badge', options: PER_DIEM_BASES },
    { key: 'currency', kind: 'code' },
    { key: 'isActive', kind: 'badge-active' },
  ],
  filters: [{ key: 'basis', options: PER_DIEM_BASES }],
  fields: [
    { key: 'name', kind: 'text', required: true },
    { key: 'basis', kind: 'select', required: true, options: PER_DIEM_BASES },
    // The linked component's tax_treatment is the single taxability
    // declaration — shown read-only beside the picker, never stored here.
    { key: 'payComponentId', kind: 'ref', ref: 'pay-components', required: true, helpTextKey: 'fieldHelp.perDiemComponent' },
    { key: 'currency', kind: 'ref', ref: 'currencies', required: true },
    { key: 'lodgingOffset', kind: 'decimal' },
    { key: 'effectiveFrom', kind: 'date', required: true },
    { key: 'effectiveTo', kind: 'date' },
  ],
}

export const CONSTRUCTION_RATIO_RULES_ENTITY: SetupEntity = {
  key: 'construction-ratio-rules',
  table: 'hrm_apprentice_ratio_rules',
  groupKey: 'workforce',
  featureKey: 'hrmConstructionCompliance',
  rehomed: true, // section on the HRM Compliance page
  rehomedTo: '/hrm/compliance',
  iconKey: 'scale',
  orgScoped: true,
  actorCols: true,
  orderBy: 'effective_from desc',
  hasActive: true,
  docSlug: 'certified-payroll-prevailing-wage-per-diem',
  columns: [
    { key: 'scheduleId', kind: 'ref', ref: 'construction-rate-schedules' },
    { key: 'measured', kind: 'text' },
    { key: 'isActive', kind: 'badge-active' },
  ],
  fields: [
    { key: 'scheduleId', kind: 'ref', ref: 'construction-rate-schedules', required: true },
    { key: 'journeyClassificationId', kind: 'ref', ref: 'construction-classifications', required: true },
    { key: 'apprenticeClassificationId', kind: 'ref', ref: 'construction-classifications', required: true },
    { key: 'ratioJourney', kind: 'integer', required: true },
    { key: 'ratioApprentice', kind: 'integer', required: true },
    {
      key: 'measured',
      kind: 'select',
      required: true,
      options: [
        { value: 'daily', labelKey: 'options.hrmRatioMeasured.daily' },
        { value: 'weekly', labelKey: 'options.hrmRatioMeasured.weekly' },
      ],
    },
    { key: 'effectiveFrom', kind: 'date', required: true },
    { key: 'effectiveTo', kind: 'date' },
  ],
}
