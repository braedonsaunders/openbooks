/** Setup-registry sales entities: promotions and restocking fee policies. */
import type { SetupEntity } from '../types'

const PROMOTION_KIND_OPTIONS = [
  { value: 'percent', labelKey: 'options.promotionKind.percent' },
  { value: 'amount', labelKey: 'options.promotionKind.amount' },
  { value: 'free_shipping', labelKey: 'options.promotionKind.free_shipping' },
  { value: 'buy_x_get_y', labelKey: 'options.promotionKind.buy_x_get_y' },
] as const

const PROMOTION_STATUS_OPTIONS = [
  { value: 'draft', labelKey: 'options.promotionStatus.draft' },
  { value: 'active', labelKey: 'options.promotionStatus.active' },
  { value: 'archived', labelKey: 'options.promotionStatus.archived' },
] as const

const RESTOCKING_FEE_KIND_OPTIONS = [
  { value: 'percent', labelKey: 'options.restockingFeeKind.percent' },
  { value: 'fixed', labelKey: 'options.restockingFeeKind.fixed' },
] as const

export const SALES_SETUP_ENTITIES: SetupEntity[] = [
  {
    key: 'promotions',
    table: 'promotions',
    singularTitleKey: 'entities.promotions.singular',
    actorCols: true,
    groupKey: 'sales',
    featureKey: 'promotions',
    writePermission: 'documents.manage',
    iconKey: 'tag',
    orgScoped: true,
    naturalKey: 'code',
    orderBy: 'code',
    hasActive: false,
    // Discount lines and redemptions reference a promotion: history is
    // archived through the status, never deleted.
    allowDelete: false,
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'kind', kind: 'badge', options: [...PROMOTION_KIND_OPTIONS] },
      { key: 'status', kind: 'badge', options: [...PROMOTION_STATUS_OPTIONS] },
      { key: 'usageCount', kind: 'number' },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      { key: 'description', kind: 'textarea' },
      { key: 'kind', kind: 'select', required: true, options: [...PROMOTION_KIND_OPTIONS] },
      { key: 'status', kind: 'select', defaultValue: 'draft', options: [...PROMOTION_STATUS_OPTIONS] },
      { key: 'percentValue', kind: 'percent', decimalScale: 4, min: 0, max: 100, showWhen: { field: 'kind', in: ['percent'] } },
      { key: 'amountMinor', kind: 'money', min: 1, showWhen: { field: 'kind', in: ['amount'] }, helpTextKey: 'fieldHelp.majorAmount' },
      { key: 'currency', kind: 'ref', ref: 'currencies', showWhen: { field: 'kind', in: ['amount'] } },
      { key: 'buyQuantity', kind: 'integer', min: 1, showWhen: { field: 'kind', in: ['buy_x_get_y'] } },
      { key: 'getQuantity', kind: 'integer', min: 1, showWhen: { field: 'kind', in: ['buy_x_get_y'] } },
      { key: 'discountAccountId', kind: 'ref', ref: 'accounts', showWhen: { field: 'kind', in: ['percent', 'amount', 'buy_x_get_y'] } },
      { key: 'startsAt', kind: 'date' },
      { key: 'endsAt', kind: 'date' },
      { key: 'usageLimit', kind: 'integer', min: 1 },
    ],
  },
  {
    key: 'restocking-fee-policies',
    table: 'restocking_fee_policies',
    singularTitleKey: 'entities.restocking-fee-policies.singular',
    actorCols: true,
    groupKey: 'inventory',
    featureKey: 'returnAuthorizations',
    writePermission: 'documents.manage',
    iconKey: 'package',
    orgScoped: true,
    orderBy: 'effective_from',
    hasActive: false,
    columns: [
      { key: 'kind', kind: 'badge' },
      { key: 'itemId', kind: 'ref', ref: 'items' },
      { key: 'itemCategory', kind: 'text' },
      { key: 'effectiveFrom', kind: 'date' },
      { key: 'effectiveTo', kind: 'date' },
      { key: 'waivable', kind: 'badge' },
    ],
    fields: [
      { key: 'kind', kind: 'select', required: true, options: [...RESTOCKING_FEE_KIND_OPTIONS] },
      { key: 'itemId', kind: 'ref', ref: 'items' },
      { key: 'itemCategory', kind: 'text' },
      { key: 'feePercent', kind: 'percent', decimalScale: 4, min: 0, max: 100, showWhen: { field: 'kind', in: ['percent'] } },
      { key: 'feeAmountMinor', kind: 'money', min: 1, showWhen: { field: 'kind', in: ['fixed'] }, helpTextKey: 'fieldHelp.majorAmount' },
      { key: 'currency', kind: 'ref', ref: 'currencies', showWhen: { field: 'kind', in: ['fixed'] } },
      { key: 'incomeAccountId', kind: 'ref', ref: 'accounts', required: true },
      { key: 'effectiveFrom', kind: 'date', required: true },
      { key: 'effectiveTo', kind: 'date' },
      { key: 'waivable', kind: 'boolean', defaultValue: true, booleanStyle: 'switch', fullWidth: true },
    ],
  },
]
