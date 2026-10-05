/** Setup-registry billing entities (split from registry.ts; pure moves only). */
import type { SetupEntity } from '../types'

export const BILLING_ENTITIES: SetupEntity[] = [
  {
    // One monthly (or weekly) invoice per payer for a customer hierarchy:
    // the payer owns the AR, the billing subsidiary issues the invoice,
    // and each line keeps its service party so cross-entity charges post
    // intercompany legs. Relationships point at these groups; the
    // consolidation scan and the run route do the collecting.
    key: 'consolidation-groups',
    table: 'consolidation_groups',
    groupKey: 'billing',
    featureKey: 'consolidatedBilling',
    iconKey: 'receipt',
    orgScoped: true,
    actorCols: true,
    naturalKey: 'code',
    hasActive: true,
    writePermission: 'documents.manage',
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'payerPartyId', labelKey: 'consolidationGroupFields.payer', kind: 'ref', ref: 'customers' },
      { key: 'cadence', labelKey: 'consolidationGroupFields.cadence', kind: 'text' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true, fullWidth: true },
      { key: 'payerPartyId', labelKey: 'consolidationGroupFields.payer', kind: 'ref', ref: 'customers', required: true },
      { key: 'billingSubsidiaryId', labelKey: 'consolidationGroupFields.billingSubsidiary', kind: 'ref', ref: 'subsidiaries' },
      { key: 'cadence', labelKey: 'consolidationGroupFields.cadence', kind: 'select', required: true, defaultValue: 'monthly', options: [
        { value: 'weekly', labelKey: 'options.consolidationCadence.weekly' },
        { value: 'monthly', labelKey: 'options.consolidationCadence.monthly' },
      ] },
      { key: 'cutoffDay', labelKey: 'consolidationGroupFields.cutoffDay', kind: 'integer', required: true, min: 1, max: 28, defaultValue: 1 },
      { key: 'grouping', labelKey: 'consolidationGroupFields.grouping', kind: 'select', required: true, defaultValue: 'by_child', options: [
        { value: 'by_child', labelKey: 'options.consolidationGrouping.byChild' },
        { value: 'by_subscription', labelKey: 'options.consolidationGrouping.bySubscription' },
        { value: 'by_product', labelKey: 'options.consolidationGrouping.byProduct' },
      ] },
      { key: 'template', labelKey: 'consolidationGroupFields.template', kind: 'text', fullWidth: true,
        helpTextKey: 'consolidationGroupFields.templateHelp' },
      { key: 'isActive', kind: 'boolean', defaultValue: true, booleanStyle: 'switch', fullWidth: true },
    ],
  },
  {
    key: 'dunning-policies', table: 'dunning_policies', groupKey: 'billing',
    iconKey: 'mail', orgScoped: true, rehomed: true, hasActive: true,
    orderBy: 'name', singularTitleKey: 'collectionPolicy', writePermission: 'documents.manage', mutationPath: '/api/dunning',
    // The aggregate endpoint validates the complete record (stages, retry
    // offsets, final action): row import cannot express it.
    importVia: 'none',
    drawerSize: 'xl', formDescriptionKey: 'collectionPolicyFields.description',
    formSections: [
      { titleKey: 'collectionPolicyFields.details', fields: ['name', 'isActive'] },
      { titleKey: 'collectionPolicyFields.criteria', fields: ['gracePeriodDays', 'minBalance', 'replyTo'] },
      { titleKey: 'collectionPolicyFields.autopay', fields: ['retryOffsetsDays', 'insufficientFundsOffsetsDays', 'expiryNoticeDays', 'finalAction'] },
    ],
    columns: [
      { key: 'name', kind: 'text' }, { key: 'gracePeriodDays', labelKey: 'collectionPolicyFields.gracePeriodDays', kind: 'number' },
      { key: 'minBalance', labelKey: 'collectionPolicyFields.minBalance', kind: 'number' }, { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'name', kind: 'text', required: true, fullWidth: true },
      { key: 'gracePeriodDays', labelKey: 'collectionPolicyFields.gracePeriodDays', kind: 'integer', required: true, min: 0, defaultValue: 0 },
      { key: 'minBalance', labelKey: 'collectionPolicyFields.minBalance', kind: 'decimal', decimalScale: 4, defaultValue: '0' },
      { key: 'replyTo', labelKey: 'collectionPolicyFields.replyTo', kind: 'text', fullWidth: true },
      { key: 'isActive', kind: 'boolean', defaultValue: true, booleanStyle: 'switch', fullWidth: true },
      { key: 'retryOffsetsDays', labelKey: 'collectionPolicyFields.retryOffsetsDays', kind: 'objectArray',
        helpTextKey: 'collectionPolicyFields.retryOffsetsHelp',
        itemTitleKey: 'collectionPolicyFields.retryDay', itemTitleField: 'days', addLabelKey: 'collectionPolicyFields.addRetry', fields: [
        { key: 'days', labelKey: 'collectionPolicyFields.retryDay', kind: 'integer', required: true, min: 1, max: 90 },
      ] },
      { key: 'insufficientFundsOffsetsDays', labelKey: 'collectionPolicyFields.insufficientFundsOffsetsDays', kind: 'objectArray',
        helpTextKey: 'collectionPolicyFields.insufficientFundsOffsetsHelp',
        itemTitleKey: 'collectionPolicyFields.retryDay', itemTitleField: 'days', addLabelKey: 'collectionPolicyFields.addRetry', fields: [
        { key: 'days', labelKey: 'collectionPolicyFields.retryDay', kind: 'integer', required: true, min: 1, max: 90 },
      ] },
      { key: 'expiryNoticeDays', labelKey: 'collectionPolicyFields.expiryNoticeDays', kind: 'integer',
        helpTextKey: 'collectionPolicyFields.expiryNoticeHelp', min: 1, max: 90, defaultValue: 30 },
      { key: 'finalAction', labelKey: 'collectionPolicyFields.finalAction', kind: 'select', defaultValue: 'none',
        helpTextKey: 'collectionPolicyFields.finalActionHelp', options: [
        { value: 'none', labelKey: 'options.autopayFinalAction.none' },
        { value: 'suspend', labelKey: 'options.autopayFinalAction.suspend' },
        { value: 'cancel', labelKey: 'options.autopayFinalAction.cancel' },
      ] },
      { key: 'stages', labelKey: 'collectionPolicyFields.stages', kind: 'objectArray', required: true,
        itemTitleKey: 'collectionPolicyFields.reminderNumber', itemTitleField: 'name', itemSequenceKey: 'sequence', addLabelKey: 'collectionPolicyFields.addReminder', fields: [
        { key: 'sequence', labelKey: 'collectionPolicyFields.sequence', kind: 'integer', required: true },
        { key: 'name', kind: 'text', required: true },
        { key: 'offsetDays', labelKey: 'collectionPolicyFields.offsetDays', kind: 'integer', required: true, defaultValue: 7 },
        { key: 'subjectTemplate', labelKey: 'collectionPolicyFields.subjectTemplate', kind: 'text', required: true, fullWidth: true },
        { key: 'bodyTemplate', labelKey: 'collectionPolicyFields.bodyTemplate', kind: 'textarea', required: true },
        { key: 'escalate', labelKey: 'collectionPolicyFields.escalate', kind: 'boolean', defaultValue: false, booleanStyle: 'switch', fullWidth: true },
      ] },
    ],
  },
  // --- Billing & numbering -------------------------------------------------
  {
    key: 'payment-terms',
    table: 'payment_terms',
    groupKey: 'billing',
    iconKey: 'calendar',
    orgScoped: true,
    orderBy: 'name',
    hasActive: true,
    columns: [
      { key: 'name', kind: 'text' },
      { key: 'netDays', kind: 'number' },
      { key: 'discountDays', kind: 'number' },
      { key: 'discountPercent', kind: 'percent' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'name', kind: 'text', required: true },
      { key: 'netDays', kind: 'integer', required: true },
      { key: 'discountDays', kind: 'integer' },
      { key: 'discountPercent', kind: 'percent' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    // Corporate cards as first-class instruments (0171): each card names its
    // holder and the single liability account it posts to, so expense reports
    // can fund company-paid and personal lines through the header
    // payment_card_id instead of hand-routing overrides per report. One row
    // per physical card — including one row per employee when (as observed at
    // a production tenant) the chart carries a liability account per cardholder. The network and
    // last-four are free-text card detail, never an allow-list: no brand or
    // product gets built-in treatment.
    key: 'payment-cards',
    table: 'payment_cards',
    groupKey: 'accounting',
    iconKey: 'payments',
    orgScoped: true,
    actorCols: true,
    orderBy: 'label',
    hasActive: true,
    columns: [
      { key: 'label', kind: 'text' },
      { key: 'holderPartyId', kind: 'ref', ref: 'employees' },
      { key: 'liabilityAccountId', kind: 'ref', ref: 'accounts' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'label', kind: 'text', required: true },
      { key: 'holderPartyId', kind: 'ref', ref: 'employees', required: true },
      { key: 'liabilityAccountId', kind: 'ref', ref: 'accounts', required: true },
      { key: 'network', kind: 'text' },
      { key: 'lastFour', kind: 'text' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    key: 'number-sequences',
    table: 'number_sequences',
    actorCols: true,
    groupKey: 'billing',
    iconKey: 'hash',
    orgScoped: true,
    orderBy: 'document_kind',
    hasActive: false,
    columns: [
      { key: 'documentKind', kind: 'ref', ref: 'number-sequence-kinds' },
      { key: 'prefix', kind: 'code' },
      { key: 'nextNumber', kind: 'number' },
      { key: 'allocatedThrough', kind: 'number' },
      { key: 'padding', kind: 'number' },
      { key: 'gapless', kind: 'boolean' },
    ],
    fields: [
      { key: 'documentKind', kind: 'ref', ref: 'number-sequence-kinds', required: true, lockedOnEdit: true },
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries', lockedOnEdit: true },
      { key: 'prefix', kind: 'text', keepDefault: true },
      { key: 'nextNumber', kind: 'integer', required: true, defaultValue: 1 },
      { key: 'padding', kind: 'integer', required: true, defaultValue: 5 },
      { key: 'gapless', kind: 'boolean', helpTextKey: 'fieldHelp.gapless' },
    ],
  },
  {
    key: 'price-levels',
    table: 'price_levels',
    actorCols: true,
    groupKey: 'billing',
    iconKey: 'tag',
    orgScoped: true,
    naturalKey: 'code',
    hasActive: true,
    orderBy: 'is_base desc, name',
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'pricingMethod', kind: 'text' },
      { key: 'percentage', kind: 'percent' },
      { key: 'costBasis', kind: 'text' },
      { key: 'isBase', kind: 'boolean' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      { key: 'pricingMethod', kind: 'select', required: true, defaultValue: 'explicit', options: [
        { value: 'explicit', labelKey: 'options.priceLevelMethod.explicit' },
        { value: 'markup_discount', labelKey: 'options.priceLevelMethod.markupDiscount' },
        { value: 'cost_plus', labelKey: 'options.priceLevelMethod.costPlus' },
      ] },
      { key: 'percentage', kind: 'percent' },
      { key: 'costBasis', kind: 'select', options: [
        { value: 'item_cost', labelKey: 'options.priceCostBasis.itemCost' },
        { value: 'standard_cost', labelKey: 'options.priceCostBasis.standardCost' },
        { value: 'average_cost', labelKey: 'options.priceCostBasis.averageCost' },
      ] },
      { key: 'isActive', kind: 'boolean', defaultValue: true },
    ],
  },
  {
    key: 'customer-price-level-assignments',
    parentRecords: [{ entityKey: 'price-levels', fieldKey: 'priceLevelId' }],
    table: 'customer_price_level_assignments',
    actorCols: true,
    groupKey: 'billing',
    iconKey: 'tag',
    orgScoped: true,
    hasActive: true,
    orderBy: 'effective_from desc',
    columns: [
      { key: 'customerId', kind: 'ref', ref: 'customers' },
      { key: 'priceLevelId', kind: 'ref', ref: 'price-levels' },
      { key: 'effectiveFrom', kind: 'date' },
      { key: 'effectiveTo', kind: 'date' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'customerId', kind: 'ref', ref: 'customers', required: true },
      { key: 'priceLevelId', kind: 'ref', ref: 'price-levels', required: true },
      { key: 'effectiveFrom', kind: 'date', required: true },
      { key: 'effectiveTo', kind: 'date' },
      { key: 'isActive', kind: 'boolean', defaultValue: true },
    ],
  },
  {
    key: 'item-rate-books',
    table: 'item_rate_books',
    rehomed: true, // lives as a tab on the Items catalog module
    actorCols: true,
    groupKey: 'billing',
    featureKey: 'projects',
    iconKey: 'tag',
    orgScoped: true,
    naturalKey: 'code',
    hasActive: true,
    docSlug: 'item-rates',
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'currency', kind: 'code' },
      { key: 'isDefault', kind: 'boolean' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      { key: 'currency', kind: 'ref', ref: 'currencies', required: true },
      { key: 'isDefault', kind: 'boolean' },
      { key: 'isActive', kind: 'boolean', defaultValue: true },
    ],
  },
  {
    key: 'item-rate-book-assignments',
    table: 'item_rate_book_assignments',
    rehomed: true, // lives on the customer & project records as an override section
    actorCols: true,
    groupKey: 'billing',
    featureKey: 'projects',
    iconKey: 'tag',
    orgScoped: true,
    orderBy: 'project_id nulls last, customer_id nulls last, effective_from desc nulls last',
    hasActive: true,
    docSlug: 'item-rates',
    columns: [
      { key: 'rateBookId', kind: 'ref', ref: 'item-rate-books' },
      { key: 'customerId', kind: 'ref', ref: 'customers' },
      { key: 'projectId', kind: 'ref', ref: 'projects' },
      { key: 'effectiveFrom', kind: 'date' },
      { key: 'effectiveTo', kind: 'date' },
      { key: 'dateBasis', kind: 'text' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'rateBookId', kind: 'ref', ref: 'item-rate-books', required: true },
      { key: 'customerId', kind: 'ref', ref: 'customers' },
      { key: 'projectId', kind: 'ref', ref: 'projects' },
      { key: 'effectiveFrom', kind: 'date' },
      { key: 'effectiveTo', kind: 'date' },
      { key: 'dateBasis', kind: 'select', required: true, defaultValue: 'usage_date', options: [
        { value: 'usage_date', labelKey: 'options.rateDateBasis.usageDate' },
        { value: 'project_start', labelKey: 'options.rateDateBasis.projectStart' },
      ] },
      { key: 'isActive', kind: 'boolean', defaultValue: true },
    ],
  },
  {
    key: 'quote-to-cash-policy', table: 'quote_to_cash_settings', groupKey: 'billing',
    featureKey: 'quoteToCash', iconKey: 'file', orgScoped: true, hasActive: false,
    singularTitleKey: 'quoteCashPolicy', writePermission: 'ar.create', mutationPath: '/api/quote-to-cash/settings',
    // A singleton validated whole by its settings endpoint: row import
    // cannot express it.
    importVia: 'none',
    drawerSize: 'lg', formDescriptionKey: 'quoteCashPolicyFields.description',
    formSections: [
      { titleKey: 'quoteCashPolicyFields.approval', fields: ['maxDiscountPercent', 'autoActivateOnSign'] },
      { titleKey: 'quoteCashPolicyFields.terms', fields: ['defaultBillingTiming', 'defaultStartRule', 'signatureExpiryDays', 'orderFormTemplateId'] },
    ],
    columns: [
      { key: 'maxDiscountPercent', kind: 'percent' },
      { key: 'autoActivateOnSign', kind: 'badge-active' },
      { key: 'signatureExpiryDays', kind: 'number' },
    ],
    fields: [
      { key: 'maxDiscountPercent', labelKey: 'quoteCashPolicyFields.maxDiscountPercent', kind: 'percent', required: true, min: 0, max: 100, defaultValue: '10', helpTextKey: 'quoteCashPolicyFields.maxDiscountPercentHelp' },
      { key: 'autoActivateOnSign', labelKey: 'quoteCashPolicyFields.autoActivateOnSign', kind: 'boolean', defaultValue: false, booleanStyle: 'switch', fullWidth: true, helpTextKey: 'quoteCashPolicyFields.autoActivateOnSignHelp' },
      { key: 'defaultBillingTiming', labelKey: 'quoteCashPolicyFields.defaultBillingTiming', kind: 'select', defaultValue: 'advance', options: [
        { value: 'advance', labelKey: 'quoteCashPolicyFields.timingAdvance' },
        { value: 'arrears', labelKey: 'quoteCashPolicyFields.timingArrears' },
      ] },
      { key: 'defaultStartRule', labelKey: 'quoteCashPolicyFields.defaultStartRule', kind: 'select', defaultValue: 'quote_date', options: [
        { value: 'quote_date', labelKey: 'quoteCashPolicyFields.startQuoteDate' },
        { value: 'first_of_next_month', labelKey: 'quoteCashPolicyFields.startNextMonth' },
        { value: 'custom', labelKey: 'quoteCashPolicyFields.startCustom' },
      ] },
      { key: 'signatureExpiryDays', labelKey: 'quoteCashPolicyFields.signatureExpiryDays', kind: 'integer', required: true, min: 1, max: 90, defaultValue: 14 },
      { key: 'orderFormTemplateId', labelKey: 'quoteCashPolicyFields.orderFormTemplateId', kind: 'ref', ref: 'pdf-templates', helpTextKey: 'quoteCashPolicyFields.orderFormTemplateHelp' },
    ],
  },
]
