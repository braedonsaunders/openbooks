/** Usage-billing setup entities. Writes delegate to the usage engine. */
import type { SetupEntity } from '../types'

export const USAGE_ENTITIES: SetupEntity[] = [
  {
    key: 'usage-meters',
    table: 'usage_meters',
    groupKey: 'billing',
    featureKey: 'usageBilling',
    iconKey: 'gauge',
    orgScoped: true,
    actorCols: true,
    naturalKey: 'key',
    orderBy: 'key',
    hasActive: true,
    allowDelete: false,
    columns: [
      { key: 'key', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'unit', kind: 'text' },
      { key: 'aggregation', kind: 'badge', options: [
        { value: 'sum', labelKey: 'options.usageAggregation.sum' },
        { value: 'count', labelKey: 'options.usageAggregation.count' },
        { value: 'max', labelKey: 'options.usageAggregation.max' },
        { value: 'last', labelKey: 'options.usageAggregation.last' },
        { value: 'unique_count', labelKey: 'options.usageAggregation.uniqueCount' },
      ] },
      { key: 'itemId', kind: 'ref', ref: 'items' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'key', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      { key: 'unit', kind: 'text', required: true },
      { key: 'aggregation', kind: 'select', required: true, lockedOnEdit: true,
        defaultValue: 'sum', helpTextKey: 'fieldHelp.usageAggregation', options: [
          { value: 'sum', labelKey: 'options.usageAggregation.sum' },
          { value: 'count', labelKey: 'options.usageAggregation.count' },
          { value: 'max', labelKey: 'options.usageAggregation.max' },
          { value: 'last', labelKey: 'options.usageAggregation.last' },
          { value: 'unique_count', labelKey: 'options.usageAggregation.uniqueCount' },
        ] },
      { key: 'itemId', kind: 'ref', ref: 'items' },
      { key: 'isActive', kind: 'boolean', defaultValue: true },
    ],
  },
  {
    key: 'usage-rating-plans',
    table: 'usage_rating_plans',
    groupKey: 'billing',
    featureKey: 'usageBilling',
    iconKey: 'list-checks',
    orgScoped: true,
    actorCols: true,
    naturalKey: 'name',
    orderBy: 'name',
    hasActive: false,
    allowDelete: false,
    columns: [
      { key: 'name', kind: 'text' },
      { key: 'currency', kind: 'code' },
      { key: 'status', kind: 'badge', options: [
        { value: 'active', labelKey: 'options.usageRatingPlanStatus.active' },
        { value: 'retired', labelKey: 'options.usageRatingPlanStatus.retired' },
      ] },
    ],
    fields: [
      { key: 'name', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'currency', kind: 'ref', ref: 'currencies', required: true, lockedOnEdit: true },
      { key: 'status', kind: 'select', required: true, defaultValue: 'active', options: [
        { value: 'active', labelKey: 'options.usageRatingPlanStatus.active' },
        { value: 'retired', labelKey: 'options.usageRatingPlanStatus.retired' },
      ] },
    ],
  },
]
