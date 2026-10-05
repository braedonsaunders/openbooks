import type { SetupEntity } from './types'

/**
 * Setup-registry descriptors for HRM compensation architecture (0221).
 *
 * Job families and levels are the org's own job architecture; pay bands
 * are the versioned SHOULD-pay rows. All three are ordinary registry
 * entities behind the hrmCompensation switch, rehomed as work areas in
 * Compensation. Company-wide policy lives in Company Setup.
 *
 * The level's equal-value criteria edit as four structured weight fields
 * (skills/effort/responsibility/working_conditions; never raw JSON —
 * registry.test.ts bars json-kind workforce fields): this fold runs
 * before buildRow so the slot keys never reach the column writer. The
 * criterion key set is closed (the directive's four), so four slots are
 * exact, never lossy. Empty weights preserve an undeclared assessment basis; no weights are
 * inferred from the level order.
 */

export const EQUAL_VALUE_CRITERIA_SLOTS = [
  ['skills', 'skillsWeight'],
  ['effort', 'effortWeight'],
  ['responsibility', 'responsibilityWeight'],
  ['working_conditions', 'workingConditionsWeight'],
] as const

export function normalizeHrmCompensationInput(
  entityKey: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (entityKey !== 'hrm-job-levels') return body
  const slots = EQUAL_VALUE_CRITERIA_SLOTS.map(([criterion, slot]) => ({
    criterion,
    weight: body[slot],
  }))
  const hasSlots = slots.some(({ weight }) => weight !== undefined)
  if (!hasSlots) return body
  // The four per-criterion inputs collapse into one equalValueCriteria
  // array, so they must not also survive as loose keys on the row.
  const rest = { ...body }
  for (const [, slot] of EQUAL_VALUE_CRITERIA_SLOTS) delete rest[slot]
  const criteria = slots
    .filter(({ weight }) => weight !== undefined && weight !== null && String(weight).trim() !== '')
    .map(({ criterion, weight }) => ({ criterion, weight: String(weight).trim() }))
  return { ...rest, equalValueCriteria: criteria }
}

const JOB_FAMILIES_BASE: SetupEntity = {
  key: 'hrm-job-families',
  singularTitleKey: 'entities.hrm-job-families.singularTitle',
  table: 'hrm_job_families',
  groupKey: 'workforce',
  featureKey: 'hrmCompensation',
  rehomed: true, // section on the Compensation page
  iconKey: 'layers',
  orgScoped: true,
  actorCols: true,
  naturalKey: 'code',
  hasActive: true,
  orderBy: 'code',
  columns: [
    { key: 'code', kind: 'code' },
    { key: 'name', kind: 'text' },
    { key: 'isActive', kind: 'badge-active' },
  ],
  fields: [
    { key: 'code', kind: 'text', required: true },
    { key: 'name', kind: 'text', required: true },
    { key: 'description', kind: 'textarea' },
    { key: 'isActive', kind: 'boolean' },
  ],
}

const JOB_LEVELS_BASE: SetupEntity = {
  key: 'hrm-job-levels',
  singularTitleKey: 'entities.hrm-job-levels.singularTitle',
  table: 'hrm_job_levels',
  groupKey: 'workforce',
  featureKey: 'hrmCompensation',
  rehomed: true, // section on the Compensation page
  iconKey: 'ladder',
  orgScoped: true,
  actorCols: true,
  naturalKey: 'code',
  hasActive: true,
  orderBy: 'rank',
  columns: [
    { key: 'code', kind: 'code' },
    { key: 'name', kind: 'text' },
    { key: 'familyId', kind: 'ref', ref: 'hrm-job-families' },
    { key: 'rank', kind: 'number' },
    { key: 'isActive', kind: 'badge-active' },
  ],
  fields: [
    { key: 'familyId', kind: 'ref', ref: 'hrm-job-families' },
    { key: 'code', kind: 'text', required: true },
    { key: 'name', kind: 'text', required: true },
    { key: 'rank', kind: 'integer', required: true },
    // The four directive criteria as structured weight slots, folded
    // into equal_value_criteria before buildRow (see above).
    { key: 'skillsWeight', kind: 'decimal', helpTextKey: 'fieldHelp.compensationCriteria' },
    { key: 'effortWeight', kind: 'decimal' },
    { key: 'responsibilityWeight', kind: 'decimal' },
    { key: 'workingConditionsWeight', kind: 'decimal' },
    { key: 'isActive', kind: 'boolean' },
  ],
}

export const PAY_BANDS_ENTITY: SetupEntity = {
  key: 'hrm-pay-bands',
  singularTitleKey: 'entities.hrm-pay-bands.singularTitle',
  table: 'hrm_pay_bands',
  groupKey: 'workforce',
  featureKey: 'hrmCompensation',
  rehomed: true, // section on the Compensation page
  iconKey: 'scale',
  orgScoped: true,
  actorCols: true,
  orderBy: 'effective_from desc',
  hasActive: false,
  columns: [
    { key: 'levelId', kind: 'ref', ref: 'hrm-job-levels' },
    { key: 'employerSubsidiaryId', kind: 'ref', ref: 'subsidiaries' },
    { key: 'locationId', kind: 'ref', ref: 'locations' },
    { key: 'currency', kind: 'code' },
    { key: 'basis', kind: 'badge', options: [
      { value: 'annual', labelKey: 'options.payBandBasis.annual' },
      { value: 'hourly', labelKey: 'options.payBandBasis.hourly' },
    ] },
    { key: 'min', kind: 'number' },
    { key: 'target', kind: 'number' },
    { key: 'max', kind: 'number' },
    { key: 'effectiveFrom', kind: 'date' },
    { key: 'effectiveTo', kind: 'date' },
  ],
  fields: [
    { key: 'familyId', kind: 'ref', ref: 'hrm-job-families' },
    { key: 'levelId', kind: 'ref', ref: 'hrm-job-levels', required: true },
    { key: 'employerSubsidiaryId', kind: 'ref', ref: 'subsidiaries' },
    { key: 'locationId', kind: 'ref', ref: 'locations' },
    { key: 'currency', kind: 'ref', ref: 'compensation-currencies', refScopeField: 'employerSubsidiaryId', required: true },
    {
      key: 'basis',
      kind: 'select',
      required: true,
      options: [
        { value: 'annual', labelKey: 'options.payBandBasis.annual' },
        { value: 'hourly', labelKey: 'options.payBandBasis.hourly' },
      ],
    },
    { key: 'min', kind: 'decimal', required: true },
    { key: 'target', kind: 'decimal', helpTextKey: 'fieldHelp.payBandTarget' },
    { key: 'max', kind: 'decimal', required: true },
    { key: 'effectiveFrom', kind: 'date', required: true },
  ],
}

/** Child bindings belong to record tabs; each top-level register stays independent. */
export const JOB_LEVELS_ENTITY: SetupEntity = {
  ...JOB_LEVELS_BASE,
  recordChildren: [{
    ...PAY_BANDS_ENTITY,
    columns: [
      ...PAY_BANDS_ENTITY.columns.filter((column) => column.key === 'effectiveFrom' || column.key === 'effectiveTo'),
      ...PAY_BANDS_ENTITY.columns.filter((column) => column.key !== 'effectiveFrom' && column.key !== 'effectiveTo'),
    ],
    parentRecords: [{ entityKey: 'hrm-job-levels', fieldKey: 'levelId' }],
  }],
}

export const JOB_FAMILIES_ENTITY: SetupEntity = {
  ...JOB_FAMILIES_BASE,
  recordChildren: [{
    ...JOB_LEVELS_ENTITY,
    parentRecords: [{ entityKey: 'hrm-job-families', fieldKey: 'familyId' }],
  }],
}
