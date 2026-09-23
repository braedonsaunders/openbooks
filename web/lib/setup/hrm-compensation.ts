import type { SetupEntity } from './registry'

/**
 * Setup-registry descriptors for HRM compensation architecture (0221).
 *
 * Job families and levels are the org's own job architecture; pay bands
 * are the versioned SHOULD-pay rows. All three are ordinary registry
 * entities behind the hrmCompensation switch, rehomed as sections onto
 * the Compensation page (and reachable in /admin/setup).
 *
 * The level's equal-value criteria edit as four structured weight fields
 * (skills/effort/responsibility/working_conditions; never raw JSON —
 * registry.test.ts bars json-kind workforce fields): this fold runs
 * before buildRow so the slot keys never reach the column writer. The
 * criterion key set is closed (the directive's four), so four slots are
 * exact, never lossy. A level with every slot empty is refused by field
 * name before the write.
 */

const EQUAL_VALUE_CRITERIA = ['skills', 'effort', 'responsibility', 'working_conditions'] as const

export function normalizeHrmCompensationInput(
  entityKey: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (entityKey !== 'hrm-job-levels') return body
  const slots = EQUAL_VALUE_CRITERIA.map((criterion) => ({
    criterion,
    weight: body[`${criterion}Weight`],
  }))
  const hasSlots = slots.some(({ weight }) => weight !== undefined)
  if (!hasSlots) return body
  // The four per-criterion inputs collapse into one equalValueCriteria
  // array, so they must not also survive as loose keys on the row.
  const rest = { ...body }
  for (const criterion of EQUAL_VALUE_CRITERIA) delete rest[`${criterion}Weight`]
  const criteria = slots
    .filter(({ weight }) => weight !== undefined && weight !== null && String(weight).trim() !== '')
    .map(({ criterion, weight }) => ({ criterion, weight: String(weight).trim() }))
  return { ...rest, equalValueCriteria: criteria }
}

export const JOB_FAMILIES_ENTITY: SetupEntity = {
  key: 'hrm-job-families',
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

export const JOB_LEVELS_ENTITY: SetupEntity = {
  key: 'hrm-job-levels',
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
    { key: 'skillsWeight', kind: 'decimal' },
    { key: 'effortWeight', kind: 'decimal' },
    { key: 'responsibilityWeight', kind: 'decimal' },
    { key: 'workingConditionsWeight', kind: 'decimal' },
    { key: 'isActive', kind: 'boolean' },
  ],
}

export const PAY_BANDS_ENTITY: SetupEntity = {
  key: 'hrm-pay-bands',
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
    { key: 'currency', kind: 'code' },
    { key: 'basis', kind: 'badge' },
    { key: 'min', kind: 'number' },
    { key: 'target', kind: 'number' },
    { key: 'max', kind: 'number' },
    { key: 'effectiveFrom', kind: 'date' },
  ],
  fields: [
    { key: 'familyId', kind: 'ref', ref: 'hrm-job-families' },
    { key: 'levelId', kind: 'ref', ref: 'hrm-job-levels', required: true },
    { key: 'employerSubsidiaryId', kind: 'ref', ref: 'subsidiaries' },
    { key: 'locationId', kind: 'ref', ref: 'locations' },
    { key: 'currency', kind: 'text', required: true },
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
    { key: 'target', kind: 'decimal', required: true },
    { key: 'max', kind: 'decimal', required: true },
    { key: 'effectiveFrom', kind: 'date', required: true },
  ],
}
