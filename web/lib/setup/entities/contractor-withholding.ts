import { CONTRACTOR_WITHHOLDING_SCHEMES } from '@openbooks/engine/country-tax-packs'
import { FILING_FREQUENCIES } from '../options'
import type { SetupEntity, SetupField } from '../types'

const field = (key: string, kind: SetupField['kind'], extra: Partial<SetupField> = {}): SetupField =>
  ({ key, kind, labelKey: `withholding.fields.${key}`, ...extra })
const standingSchemes = CONTRACTOR_WITHHOLDING_SCHEMES.filter(scheme => scheme.standingSource !== 'vendor_backup_withholding').map(scheme => ({ value: scheme.code, label: scheme.name }))
const schemes = CONTRACTOR_WITHHOLDING_SCHEMES.map(scheme => ({ value: scheme.code, label: scheme.name }))

export const CONTRACTOR_WITHHOLDING_ENTITIES: SetupEntity[] = [
  {
    key: 'withholding-enrollments', table: 'withholding_enrollments', groupKey: 'taxes', iconKey: 'receipt',
    featureKey: 'contractorWithholding', orgScoped: true, actorCols: true, hasActive: true,
    orderBy: 'effective_from desc, id', allowDelete: false,
    titleKey: 'withholding.enrollments', singularTitleKey: 'withholding.enrollment',
    columns: [
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries', labelKey: 'withholding.fields.subsidiaryId' },
      { key: 'schemeCode', kind: 'badge', options: schemes, labelKey: 'withholding.fields.schemeCode' },
      { key: 'contractorReference', kind: 'text', labelKey: 'withholding.fields.contractorReference' },
      { key: 'effectiveFrom', kind: 'date', labelKey: 'withholding.fields.effectiveFrom' },
      { key: 'effectiveTo', kind: 'date', labelKey: 'withholding.fields.effectiveTo' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      field('subsidiaryId', 'ref', { ref: 'subsidiaries', required: true, legalEmployer: true, lockedOnEdit: true }),
      field('schemeCode', 'select', { required: true, options: schemes, lockedOnEdit: true }),
      field('contractorReference', 'text', { required: true, lockedOnEdit: true }),
      field('liabilityAccountId', 'ref', { ref: 'accounts', required: true, lockedOnEdit: true, refAccountTypes: ['liability_current_other', 'liability_long_term'] }),
      field('authorityPartyId', 'ref', { ref: 'vendors' }),
      field('returnFrequency', 'select', { scopedOptions: { scopeField: 'schemeCode', byValue: Object.fromEntries(CONTRACTOR_WITHHOLDING_SCHEMES.map(scheme => [scheme.code, FILING_FREQUENCIES.filter(option => (scheme.returnFrequencies ?? [scheme.returnFrequency ?? 'monthly']).includes(option.value as 'monthly' | 'quarterly' | 'annual'))])) } }),
      field('thresholdBasis', 'select', { scopedOptions: { scopeField: 'schemeCode', byValue: Object.fromEntries(CONTRACTOR_WITHHOLDING_SCHEMES.map(scheme => [scheme.code, (scheme.thresholdBases ?? []).map(basis => ({ value: basis.code, label: basis.name }))])) } }),
      field('payerScope', 'select', { showWhen: { field: 'schemeCode', in: ['IT_RITENUTA_APPALTI'] }, clearWhenHidden: true, scopedOptions: { scopeField: 'schemeCode', byValue: Object.fromEntries(CONTRACTOR_WITHHOLDING_SCHEMES.map(scheme => [scheme.code, scheme.payerScope ? [{ value: scheme.payerScope, labelKey: 'withholdingCondominiumPayer' }] : []])) } }),
      field('remittanceScheduleCode', 'select', { showWhen: { field: 'schemeCode', in: ['IT_RITENUTA_APPALTI', 'US_BACKUP_WITHHOLDING'] }, clearWhenHidden: true, scopedOptions: { scopeField: 'schemeCode', byValue: Object.fromEntries(CONTRACTOR_WITHHOLDING_SCHEMES.map(scheme => [scheme.code, [...new Map((scheme.remittanceSchedules ?? []).map(schedule => [schedule.code, { value: schedule.code, label: schedule.name }])).values()]])) } }),
      field('remittancePolicy', 'object', { showWhen: { field: 'schemeCode', in: ['IT_RITENUTA_APPALTI', 'US_BACKUP_WITHHOLDING'] }, clearWhenHidden: true, fullWidth: true, fields: [
        field('calendar', 'object', { fields: [field('from', 'date'), field('to', 'date'), field('closedDates', 'stringArray'), field('sourceReference', 'text')] }),
        field('lookback', 'object', { fields: [field('taxYear', 'integer', { min: 1, max: 9999 }), field('totalTax', 'decimal', { decimalScale: 4 }), field('sourceReference', 'text')] }),
        field('finalAnnualLiability', 'object', { fields: [field('taxYear', 'integer', { min: 1, max: 9999 }), field('totalTax', 'decimal', { decimalScale: 4 }), field('sourceReference', 'text')] }),
        field('nextDayEventOn', 'date'),
        field('other945Liabilities', 'objectArray', { fields: [field('date', 'date'), field('amount', 'decimal', { decimalScale: 4 }), field('sourceReference', 'text')] }),
      ] }),
      field('effectiveFrom', 'date', { required: true, lockedOnEdit: true }),
      field('effectiveTo', 'date'),
      field('isActive', 'boolean', { defaultValue: true }),
    ],
  },
  {
    key: 'withholding-standings', table: 'withholding_standings', groupKey: 'taxes', iconKey: 'shield',
    featureKey: 'contractorWithholding', orgScoped: true, actorCols: true, hasActive: false,
    orderBy: 'valid_from desc, id', allowDelete: false, importVia: 'none',
    titleKey: 'withholding.standings', singularTitleKey: 'withholding.standing',
    mutationPath: '/api/contractor-withholding/standings',
    mutationCreateKeys: ['subsidiaryId', 'partyId', 'schemeCode', 'bandCode', 'verificationReference', 'verifiedOn', 'validFrom', 'validTo', 'payeeReference', 'payeeTaxOffice', 'applyFromFirstPayment', 'notes'],
    mutationUpdateKeys: ['subsidiaryId', 'partyId', 'schemeCode', 'bandCode', 'verificationReference', 'verifiedOn', 'validFrom', 'validTo', 'payeeReference', 'payeeTaxOffice', 'applyFromFirstPayment', 'notes'],
    columns: [
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries', labelKey: 'withholding.fields.subsidiaryId' },
      { key: 'partyId', kind: 'ref', ref: 'vendors', labelKey: 'withholding.fields.partyId' },
      { key: 'schemeCode', kind: 'badge', options: standingSchemes, labelKey: 'withholding.fields.schemeCode' },
      { key: 'bandCode', kind: 'text', labelKey: 'withholding.fields.bandCode' },
      { key: 'validFrom', kind: 'date', labelKey: 'withholding.fields.validFrom' },
      { key: 'validTo', kind: 'date', labelKey: 'withholding.fields.validTo' },
      { key: 'status', kind: 'badge' },
    ],
    fields: [
      field('subsidiaryId', 'ref', { ref: 'subsidiaries', required: true, legalEmployer: true }),
      field('partyId', 'ref', { ref: 'vendors', required: true, lockedOnEdit: true }),
      field('schemeCode', 'select', { required: true, options: standingSchemes, lockedOnEdit: true }),
      field('bandCode', 'select', { required: true, scopedOptions: { scopeField: 'schemeCode', byValue: Object.fromEntries(CONTRACTOR_WITHHOLDING_SCHEMES.map(scheme => [scheme.code, scheme.bands.map(band => ({ value: band.code, label: band.name }))])) } }),
      field('verificationReference', 'text'), field('verifiedOn', 'date'),
      field('validFrom', 'date', { required: true }), field('validTo', 'date'),
      field('payeeReference', 'text'), field('payeeTaxOffice', 'text'),
      field('applyFromFirstPayment', 'boolean', { defaultValue: false }), field('notes', 'textarea', { fullWidth: true }),
    ],
  },
]
