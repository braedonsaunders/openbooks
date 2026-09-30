/** Manufacturing setup entities (registered by the setup switchboard). */
import type { SetupEntity } from '../types'

export const MANUFACTURING_ENTITIES: SetupEntity[] = [
  {
    key: 'mfg-scrap-reasons',
    table: 'mfg_scrap_reasons',
    actorCols: true,
    groupKey: 'inventory',
    rehomed: true,
    featureKey: 'manufacturing',
    iconKey: 'package',
    orgScoped: true,
    orderBy: 'code',
    hasActive: true,
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'classification', kind: 'text', options: [
        { value: 'normal', labelKey: 'options.manufacturingScrap.normal' },
        { value: 'abnormal', labelKey: 'options.manufacturingScrap.abnormal' },
      ] },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true },
      { key: 'name', kind: 'text', required: true },
      { key: 'classification', kind: 'select', required: true, options: [
        { value: 'normal', labelKey: 'options.manufacturingScrap.normal' },
        { value: 'abnormal', labelKey: 'options.manufacturingScrap.abnormal' },
      ] },
      { key: 'isActive', kind: 'boolean', defaultValue: true },
    ],
  },
  {
    key: 'mfg-item-policies',
    table: 'mfg_item_policies',
    naturalKey: 'itemId',
    actorCols: true,
    // Writes use the dedicated service route so transfer eligibility is checked.
    readOnly: true,
    groupKey: 'inventory',
    rehomed: true,
    featureKey: 'manufacturing',
    iconKey: 'package',
    orgScoped: true,
    orderBy: 'item_id',
    hasActive: false,
    columns: [
      { key: 'itemId', kind: 'ref', ref: 'items' },
      { key: 'supplyMethod', kind: 'text' },
      { key: 'leadTimeDays', kind: 'number' },
      { key: 'safetyStockQty', kind: 'number' },
      { key: 'minimumQty', kind: 'number' },
      { key: 'orderMultipleQty', kind: 'number' },
      { key: 'scrapPctPlanned', kind: 'percent' },
    ],
    fields: [
      { key: 'itemId', kind: 'ref', ref: 'items', required: true, lockedOnEdit: true },
      { key: 'supplyMethod', kind: 'select', required: true, defaultValue: 'make', options: [
        { value: 'make', labelKey: 'options.manufacturingSupplyMethod.make' },
        { value: 'buy', labelKey: 'options.manufacturingSupplyMethod.buy' },
        { value: 'transfer', labelKey: 'options.manufacturingSupplyMethod.transfer' },
      ] },
      { key: 'leadTimeDays', kind: 'integer' },
      { key: 'safetyStockQty', kind: 'decimal', required: true, defaultValue: '0' },
      { key: 'minimumQty', kind: 'decimal', required: true, defaultValue: '0' },
      { key: 'orderMultipleQty', kind: 'decimal', required: true, defaultValue: '0' },
      { key: 'scrapPctPlanned', kind: 'percent', required: true, defaultValue: '0' },
    ],
  },
]
