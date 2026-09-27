/** Setup-registry warehouse entities, re-homed on the Warehouse cockpit. */
import type { SetupEntity, SetupOption } from '../types'

const WAREHOUSE_STATUSES: SetupOption[] = [
  { value: 'draft', labelKey: 'options.warehouseStatus.draft' },
  { value: 'active', labelKey: 'options.warehouseStatus.active' },
  { value: 'suspended', labelKey: 'options.warehouseStatus.suspended' },
  { value: 'retired', labelKey: 'options.warehouseStatus.retired' },
]

const PUTAWAY_STRATEGIES: SetupOption[] = [
  { value: 'fixed-bin', labelKey: 'options.putawayStrategy.fixed-bin' },
  { value: 'empty-bin', labelKey: 'options.putawayStrategy.empty-bin' },
  { value: 'bulk-zone', labelKey: 'options.putawayStrategy.bulk-zone' },
]

export const WAREHOUSE_ENTITIES: SetupEntity[] = [
  {
    // Name and address of a warehouse-kind stock location. A warehouse is
    // created in draft from the cockpit (or by creating a warehouse-kind
    // stock location), and its status moves only through the lifecycle
    // actions, so this entity neither creates, deletes nor edits status.
    key: 'warehouses',
    table: 'warehouses',
    idColumn: 'stock_location_id',
    singularTitleKey: 'entities.warehouses.singular',
    rehomed: true,
    rehomedTo: '/warehouse',
    actorCols: true,
    groupKey: 'inventory',
    featureKey: 'warehousing',
    iconKey: 'package',
    orgScoped: true,
    orderBy: 'name',
    hasActive: false,
    allowCreate: false,
    allowDelete: false,
    columns: [
      { key: 'stockLocationId', kind: 'ref', ref: 'stock-locations' },
      { key: 'name', kind: 'text' },
      { key: 'status', kind: 'badge', options: WAREHOUSE_STATUSES },
      { key: 'city', kind: 'text' },
      { key: 'country', kind: 'text' },
    ],
    fields: [
      { key: 'name', kind: 'text', required: true },
      { key: 'addressLine1', kind: 'text', sectionKey: 'sections.address' },
      { key: 'addressLine2', kind: 'text', sectionKey: 'sections.address' },
      { key: 'city', kind: 'text', sectionKey: 'sections.address' },
      { key: 'region', kind: 'text', sectionKey: 'sections.address' },
      { key: 'postalCode', kind: 'text', sectionKey: 'sections.address' },
      { key: 'country', kind: 'country', sectionKey: 'sections.address' },
    ],
  },
  {
    // Ordered putaway rules: resolution walks them by sequence. Storage
    // refuses a target outside the rule's warehouse and a bulk zone with no
    // capacity.
    key: 'putaway-rules',
    table: 'putaway_rules',
    singularTitleKey: 'entities.putaway-rules.singular',
    rehomed: true,
    rehomedTo: '/warehouse',
    actorCols: true,
    groupKey: 'inventory',
    featureKey: 'warehousing',
    iconKey: 'package',
    orgScoped: true,
    orderBy: 'warehouse_id, sequence',
    hasActive: false,
    columns: [
      { key: 'warehouseId', kind: 'ref', ref: 'warehouses' },
      { key: 'sequence', kind: 'number' },
      { key: 'itemId', kind: 'ref', ref: 'items' },
      { key: 'strategy', kind: 'badge', options: PUTAWAY_STRATEGIES },
      { key: 'targetLocationId', kind: 'ref', ref: 'stock-locations' },
      { key: 'capacityQuantity', kind: 'number' },
    ],
    fields: [
      { key: 'warehouseId', kind: 'ref', ref: 'warehouses', required: true },
      { key: 'sequence', kind: 'integer', required: true, min: 1 },
      { key: 'itemId', kind: 'ref', ref: 'items', helpTextKey: 'fieldHelp.putawayItem' },
      { key: 'strategy', kind: 'select', options: PUTAWAY_STRATEGIES, required: true },
      { key: 'targetLocationId', kind: 'ref', ref: 'stock-locations', required: true },
      { key: 'capacityQuantity', kind: 'decimal', helpTextKey: 'fieldHelp.putawayCapacity' },
    ],
  },
]
