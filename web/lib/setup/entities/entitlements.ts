/** SaaS entitlement feature catalog. Creates and updates run through the entitlement engine (write.ts delegation). */
import type { SetupEntity } from '../types'

export const ENTITLEMENT_ENTITIES: SetupEntity[] = [
  {
    key: 'saas-features',
    table: 'saas_features',
    groupKey: 'billing',
    featureKey: 'advancedSubscriptions',
    iconKey: 'sparkles',
    orgScoped: true,
    actorCols: true,
    naturalKey: 'key',
    orderBy: 'key',
    hasActive: true,
    allowDelete: false,
    columns: [
      { key: 'key', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'featureType', kind: 'badge', options: [
        { value: 'boolean', labelKey: 'options.saasFeatureType.boolean' },
        { value: 'quantity', labelKey: 'options.saasFeatureType.quantity' },
        { value: 'metered', labelKey: 'options.saasFeatureType.metered' },
        { value: 'custom', labelKey: 'options.saasFeatureType.custom' },
      ] },
      { key: 'unit', kind: 'text' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'key', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      { key: 'description', kind: 'text', fullWidth: true },
      { key: 'featureType', kind: 'select', required: true, lockedOnEdit: true,
        defaultValue: 'boolean', options: [
          { value: 'boolean', labelKey: 'options.saasFeatureType.boolean' },
          { value: 'quantity', labelKey: 'options.saasFeatureType.quantity' },
          { value: 'metered', labelKey: 'options.saasFeatureType.metered' },
          { value: 'custom', labelKey: 'options.saasFeatureType.custom' },
        ] },
      { key: 'unit', kind: 'text' },
      { key: 'meterKey', kind: 'text', helpTextKey: 'fieldHelp.saasFeatureMeter' },
      { key: 'isActive', kind: 'boolean', defaultValue: true },
    ],
  },
]
