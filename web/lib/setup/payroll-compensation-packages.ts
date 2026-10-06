import { compensationPackagePattern } from '@openbooks/engine/payroll/compensation-patterns'
import type { CompensationPackageRecord, CompensationPackageVersion } from '@openbooks/engine/payroll/compensation-packages'
import type { SetupEntity, SetupField, SetupOption } from './types'

const label = (key: string) => `compensationPackages.${key}`
const options = (values: readonly string[]): SetupOption[] => values.map(value => ({ value, labelKey: label(`options.${value}`) }))
const reason: SetupField = { key: 'reason', kind: 'textarea', required: true, resetOnEdit: true, labelKey: label('reason'), helpTextKey: label('reasonHint') }
const dates: SetupField[] = [{ key: 'effectiveFrom', kind: 'date', required: true }, { key: 'effectiveTo', kind: 'date' }]
const common = { groupKey: 'workforce', featureKey: 'compensationPackages', orgScoped: true, actorCols: true, hasActive: false, rehomed: true, iconKey: 'banknote', importVia: 'none', allowDelete: false, writePermission: 'payroll.manage', mutationRevision: { requestKey: 'expectedRevision', rowColumn: 'revision' } } as const

export const PAYROLL_COMPENSATION_PACKAGES_ENTITY: SetupEntity = {
  ...common, key: 'payroll-compensation-packages', table: 'payroll_compensation_packages', naturalKey: 'code',
  mutationPath: '/api/payroll/compensation-packages', createDestination: { rowParam: 'package', tabKey: 'versions' },
  mutationCreateKeys: ['subsidiaryId', 'code', 'name', 'description', 'country', 'currency', 'reason'],
  mutationUpdateKeys: ['name', 'description', 'retire', 'reason', 'expectedRevision'],
  columns: [{ key: 'code', kind: 'code' }, { key: 'name', kind: 'text' }, { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries', labelKey: 'fields.legalEmployer' }, { key: 'country', kind: 'code' }, { key: 'currency', kind: 'code' }, { key: 'status', kind: 'text', labelKey: label('status') }],
  fields: [
    { key: 'code', kind: 'text', required: true, lockedOnEdit: true }, { key: 'name', kind: 'text', required: true },
    { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries', legalEmployer: true, required: true, lockedOnEdit: true, labelKey: 'fields.legalEmployer' },
    { key: 'country', kind: 'select', optionsSource: 'payroll-component-countries', required: true, lockedOnEdit: true },
    { key: 'currency', kind: 'ref', ref: 'compensation-currencies', refScopeField: 'subsidiaryId', required: true, lockedOnEdit: true },
    { key: 'description', kind: 'textarea' }, { key: 'retire', kind: 'boolean', defaultValue: false, labelKey: label('retire'), helpTextKey: label('retireHint') }, reason,
  ],
  creationSteps: [{ key: 'identity', titleKey: label('identity'), descriptionKey: label('identityHint'), fields: ['code', 'name', 'subsidiaryId', 'country', 'currency'] }, { key: 'review', titleKey: label('context'), descriptionKey: label('contextHint'), fields: ['description', 'reason'] }],
}

const numericKinds = ['scalar', 'money', 'hours', 'hourly_rate']
const inputFields: SetupField[] = [
  { key: 'name', kind: 'text', required: true, labelKey: label('inputName') },
  { key: 'type', kind: 'object', required: true, labelKey: label('inputType'), fields: [
    { key: 'kind', kind: 'select', required: true, options: options([...numericKinds, 'boolean']), labelKey: label('inputType') },
    { key: 'currency', kind: 'text', required: true, labelKey: 'fields.currency', omitWhenHidden: true, showWhen: { field: 'kind', in: ['money', 'hourly_rate'] } },
  ] },
  { key: 'source', kind: 'select', required: true, options: options(['assignment', 'constant', 'period_gross', 'period_hours', 'hourly_wage']), scopedOptions: { scopeField: 'type.kind', byValue: {
    money: options(['assignment', 'constant', 'period_gross']), hours: options(['assignment', 'constant', 'period_hours']),
    hourly_rate: options(['assignment', 'constant', 'hourly_wage']), scalar: options(['assignment', 'constant']), boolean: options(['assignment', 'constant']),
  } }, labelKey: label('source'), helpTextKey: label('sourceHint') },
  { key: 'value', kind: 'decimal', decimalScale: 18, required: true, labelKey: label('value'), showWhen: { all: [{ field: 'source', in: ['constant'] }, { field: 'type.kind', in: numericKinds }] } },
  { key: 'value', kind: 'boolean', nullable: true, required: true, labelKey: label('value'), showWhen: { all: [{ field: 'source', in: ['constant'] }, { field: 'type.kind', in: ['boolean'] }] } },
  ...['minimum', 'maximum'].map((key): SetupField => ({ key, kind: 'decimal', decimalScale: 18, required: true, labelKey: label(key), helpTextKey: label('boundsHint'), omitWhenHidden: true, showWhen: { field: 'type.kind', in: numericKinds } })),
]
const ruleFields: SetupField[] = [
  { key: 'key', kind: 'text', required: true, labelKey: label('ruleKey') },
  { key: 'componentId', kind: 'ref', ref: 'compensation-package-components', required: true, labelKey: label('component') },
  { key: 'expression', kind: 'text', required: true, labelKey: label('expression'), helpTextKey: label('expressionHint') },
  { key: 'condition', kind: 'text', labelKey: label('condition'), helpTextKey: label('conditionHint') },
  { key: 'proration', kind: 'select', required: true, options: options(['none', 'calendar_days']), defaultValue: 'none', labelKey: label('proration'), helpTextKey: label('prorationHint') },
  { key: 'rounding', kind: 'object', required: true, labelKey: label('rounding'), defaultValue: { scale: 4, mode: 'half_away_from_zero', maxWholeDigits: 15 }, fields: [
    { key: 'scale', kind: 'integer', min: 0, max: 4, required: true, labelKey: label('scale') }, { key: 'mode', kind: 'select', required: true, options: options(['half_away_from_zero', 'half_even', 'towards_zero']), labelKey: label('roundingMode') }, { key: 'maxWholeDigits', kind: 'integer', defaultValue: 15, hidden: true },
  ] },
]
export const PAYROLL_COMPENSATION_VERSIONS_ENTITY: SetupEntity = {
  ...common, key: 'payroll-compensation-versions', table: 'payroll_compensation_versions', createDestination: { rowParam: 'packageVersionsRow', tabKey: 'review' }, orderBy: 'version desc, id', nestedUnder: 'payroll-compensation-packages', parentRecords: [{ entityKey: 'payroll-compensation-packages', fieldKey: 'packageId' }],
  mutationPath: '/api/payroll/compensation-packages', mutationCreateKeys: ['effectiveFrom', 'effectiveTo', 'definition', 'reason'], mutationUpdateKeys: ['effectiveFrom', 'effectiveTo', 'definition', 'reason', 'expectedRevision'],
  columns: [{ key: 'version', kind: 'text', labelKey: label('version') }, { key: 'effectiveFrom', kind: 'date' }, { key: 'effectiveTo', kind: 'date' }, { key: 'status', kind: 'text', labelKey: label('status') }],
  fields: [{ key: 'packageId', kind: 'ref', ref: 'payroll-compensation-packages', required: true, hidden: true, labelKey: label('package') }, ...dates,
    { key: 'definition', kind: 'object', required: true, labelKey: label('definition'), fields: [
      { key: 'orgId', kind: 'text', hidden: true }, { key: 'country', kind: 'text', hidden: true }, { key: 'currency', kind: 'text', hidden: true },
      { key: 'partialPeriod', kind: 'select', required: true, options: options(['allow', 'refuse']), labelKey: label('partialPeriod'), helpTextKey: label('partialPeriodHint') },
      { key: 'inputs', kind: 'objectArray', fields: inputFields, labelKey: label('inputs'), itemTitleKey: label('inputNumber'), itemTitleField: 'name', addLabelKey: label('addInput') },
      { key: 'rules', kind: 'objectArray', fields: ruleFields, required: true, labelKey: label('rules'), itemTitleKey: label('ruleNumber'), itemTitleField: 'key', addLabelKey: label('addRule') },
    ] }, reason],
}
export const PAYROLL_COMPENSATION_ASSIGNMENTS_ENTITY: SetupEntity = {
  ...common, key: 'payroll-compensation-assignments', table: 'payroll_compensation_assignments', createDestination: { rowParam: 'packageAssignmentsRow', tabKey: 'review' }, orderBy: 'effective_from desc, id', nestedUnder: 'payroll-compensation-packages', parentRecords: [{ entityKey: 'payroll-compensation-packages', fieldKey: 'packageId' }],
  mutationPath: '/api/payroll/compensation-packages', mutationCreateKeys: ['versionId', 'employmentId', 'effectiveFrom', 'effectiveTo', 'inputs', 'reason'], mutationUpdateKeys: ['versionId', 'employmentId', 'effectiveFrom', 'effectiveTo', 'inputs', 'reason', 'expectedRevision'],
  columns: [{ key: 'employmentId', kind: 'ref', ref: 'worker-employments', labelKey: label('employment') }, { key: 'effectiveFrom', kind: 'date' }, { key: 'effectiveTo', kind: 'date' }, { key: 'status', kind: 'text', labelKey: label('status') }],
  fields: [{ key: 'packageId', kind: 'ref', ref: 'payroll-compensation-packages', required: true, hidden: true, labelKey: label('package') }, { key: 'versionId', kind: 'ref', ref: 'approved-compensation-package-versions', refScopeField: 'packageId', required: true, lockedOnEdit: true, labelKey: label('version') }, { key: 'employmentId', kind: 'ref', ref: 'worker-employments', refScopeField: 'subsidiaryId', required: true, lockedOnEdit: true, labelKey: label('employment') }, { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries', legalEmployer: true, hidden: true }, ...dates, { key: 'inputs', kind: 'object', required: true, labelKey: label('assignmentInputs'), fields: [] }, reason],
}

/** Pattern cards prefill one native policy; bounds and employee values remain deliberate choices. */
export function packageVersionPresentation(pack: CompensationPackageRecord, orgId: string, creating: boolean): SetupEntity {
  const numeric = (name: string, kind: 'money' | 'hourly_rate' | 'hours' | 'scalar', source: 'assignment' | 'period_gross' | 'period_hours' | 'hourly_wage') => ({ name, type: ['money', 'hourly_rate'].includes(kind) ? { kind, currency: pack.currency } : { kind }, source, minimum: '0', maximum: '' })
  const patterns = [
    { key: 'fixed' as const, inputs: [numeric('amount', 'money', 'assignment')], args: { amountInput: 'amount' } },
    { key: 'hourly' as const, inputs: [numeric('wage', 'hourly_rate', 'hourly_wage'), numeric('hours', 'hours', 'period_hours')], args: { amountInput: 'wage', factorInput: 'hours' } },
    { key: 'percentage' as const, inputs: [numeric('gross', 'money', 'period_gross'), numeric('percentage', 'scalar', 'assignment')], args: { amountInput: 'gross', factorInput: 'percentage' } },
    { key: 'conditional' as const, inputs: [numeric('amount', 'money', 'assignment'), { name: 'eligible', type: { kind: 'boolean' }, source: 'assignment' }], args: { amountInput: 'amount', conditionInput: 'eligible' } },
  ]
  function currencyControls(field: SetupField): SetupField {
    const projected = { ...field, ...(field.fields ? { fields: field.fields.map(currencyControls) } : {}) }
    if (field.key === 'currency' && !field.hidden) return { ...projected, kind: 'select', options: [{ value: pack.currency, label: pack.currency }] }
    if (field.key === 'rounding') return { ...projected, defaultValue: { ...field.defaultValue as object, scale: pack.currencyMinorUnits } }
    if (field.key === 'scale') return { ...projected, max: pack.currencyMinorUnits }
    return projected
  }
  return { ...PAYROLL_COMPENSATION_VERSIONS_ENTITY, fields: PAYROLL_COMPENSATION_VERSIONS_ENTITY.fields.map(currencyControls), mutationPath: `/api/payroll/compensation-packages/${pack.id}/versions`, createChooser: creating ? { titleKey: label('choosePattern'), descriptionKey: label('patternHint'), options: patterns.map(pattern => ({ key: pattern.key, labelKey: label(`patterns.${pattern.key}`), descriptionKey: label(`patternDescriptions.${pattern.key}`), iconKey: 'banknote', values: { definition: { orgId, country: pack.country, currency: pack.currency, partialPeriod: 'refuse', inputs: pattern.inputs, rules: [{ key: 'payment', componentId: '', expression: compensationPackagePattern({ pattern: pattern.key, ...pattern.args }), condition: null, proration: 'none', rounding: { scale: pack.currencyMinorUnits, mode: 'half_away_from_zero', maxWholeDigits: 15 } }] } } })) } : undefined }
}

/** Employee controls are built from the approved version, never copied policy values. */
export function packageAssignmentPresentation(pack: CompensationPackageRecord, version: CompensationPackageVersion | undefined): SetupEntity {
  return { ...PAYROLL_COMPENSATION_ASSIGNMENTS_ENTITY, mutationPath: `/api/payroll/compensation-packages/${pack.id}/assignments`, fields: PAYROLL_COMPENSATION_ASSIGNMENTS_ENTITY.fields.map(field => field.key !== 'inputs' ? field : { ...field, fields: (version?.definition.inputs ?? []).filter(input => input.source === 'assignment').map((input): SetupField => ({ key: input.name, kind: input.type.kind === 'boolean' ? 'boolean' : 'decimal', decimalScale: 18, nullable: input.type.kind === 'boolean', required: true, label: input.name })) }) }
}
