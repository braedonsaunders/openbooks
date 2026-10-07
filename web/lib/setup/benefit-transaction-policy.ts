import type { SetupEntity, SetupField } from './types'

const field = (key: string, kind: SetupField['kind'], extra: Partial<SetupField> = {}): SetupField => ({ key, kind, labelKey: `transactionBenefits.fields.${key}`, ...extra })
const group = () => field('groupId', 'ref', { ref: 'benefit-transaction-groups', refScopeField: 'groupingSegmentId', required: true })

/** The parent program owns one audited aggregate, rather than five independent settings lists. */
export const BENEFIT_TRANSACTION_POLICY_ENTITY: SetupEntity = {
  key: 'benefit-transaction-policy', table: 'hrm_benefit_programs', rehomed: true,
  groupKey: 'workforce', featureKey: 'hrm', iconKey: 'gift', orgScoped: true,
  actorCols: true, naturalKey: 'code', hasActive: false, allowCreate: false, allowDelete: false,
  titleKey: 'transactionBenefits.title', singularTitleKey: 'transactionBenefits.title',
  writePermission: 'hrm.benefits.manage', importVia: 'none', drawerSize: '2xl',
  mutationPath: '/api/hrm/benefit-transaction-rules',
  mutationRevision: { requestKey: 'expectedRevision', rowColumn: 'revision' },
  mutationUpdateKeys: ['documentKind', 'dateBasis', 'groupingSegmentId', 'itemIds', 'positions', 'responsibilities', 'limits', 'reason', 'expectedRevision'],
  columns: [{ key: 'code', kind: 'code' }, { key: 'name', kind: 'text' }],
  recordSections: [
    { key: 'source', titleKey: 'transactionBenefits.source', descriptionKey: 'transactionBenefits.sourceHint', fields: ['documentKind', 'dateBasis', 'groupingSegmentId', 'itemIds'] },
    { key: 'positions', titleKey: 'transactionBenefits.positions', descriptionKey: 'transactionBenefits.positionsHint', fields: ['positions'] },
    { key: 'responsibilities', titleKey: 'transactionBenefits.responsibilities', descriptionKey: 'transactionBenefits.responsibilitiesHint', fields: ['responsibilities'] },
    { key: 'limits', titleKey: 'transactionBenefits.limits', descriptionKey: 'transactionBenefits.limitsHint', fields: ['limits'] },
    { key: 'reason', titleKey: 'transactionBenefits.reason', descriptionKey: 'transactionBenefits.reasonHint', fields: ['reason'] },
  ],
  fields: [
    field('documentKind', 'select', { required: true, options: ['sales_order', 'customer_invoice', 'field_ticket', 'quote'].map(value => ({ value, labelKey: `transactionBenefits.kinds.${value}` })) }),
    field('dateBasis', 'select', { required: true, options: [{ value: 'document_date', labelKey: 'transactionBenefits.documentDate' }] }),
    field('groupingSegmentId', 'ref', { ref: 'segment-definitions', helpTextKey: 'transactionBenefits.companyGrouping' }),
    field('itemIds', 'multiref', { ref: 'items', required: true, searchableReferences: true, fullWidth: true }),
    field('positions', 'objectArray', { required: true, fullWidth: true, itemTitleField: 'name', fields: [
      field('key', 'text', { required: true }), field('name', 'text', { required: true }), field('weight', 'decimal', { required: true, decimalScale: 4, defaultValue: '1' }),
    ] }),
    field('responsibilities', 'objectArray', { fullWidth: true, fields: [
      group(), field('positionKey', 'select', { required: true, optionsFromField: { field: 'positions', valueKey: 'key', labelKey: 'name' } }),
      field('employmentId', 'ref', { required: true, ref: 'worker-employments' }),
      field('effectiveFrom', 'date', { required: true }), field('effectiveTo', 'date'),
    ] }),
    field('limits', 'objectArray', { fullWidth: true, fields: [
      group(), field('kind', 'select', { required: true, defaultValue: 'none', options: ['none', 'amount'].map(value => ({ value, labelKey: `transactionBenefits.limitKinds.${value}` })) }),
      field('amount', 'decimal', { required: true, decimalScale: 4, showWhen: { field: 'kind', in: ['amount'] }, clearWhenHidden: true }),
    ] }),
    field('reason', 'textarea', { required: true, fullWidth: true, resetOnEdit: true }),
  ],
}
