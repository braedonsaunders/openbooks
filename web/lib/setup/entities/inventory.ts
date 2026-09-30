/** Setup-registry inventory entities (split from registry.ts; pure moves only). */
import type { SetupEntity } from '../types'
import { COSTING_METHODS, INVENTORY_TRACKING, STOCK_LOCATION_KINDS } from '../options'

export const INVENTORY_ENTITIES: SetupEntity[] = [
  {
    key: 'item-identifiers',
    table: 'item_identifiers',
    singularTitleKey: 'entities.item-identifiers.singular',
    actorCols: true,
    groupKey: 'inventory',
    featureKey: 'barcodeScanning',
    writePermission: 'items.manage',
    iconKey: 'package',
    orgScoped: true,
    naturalKey: 'value',
    hasActive: false,
    columns: [
      { key: 'itemId', kind: 'ref', ref: 'items' },
      { key: 'kind', kind: 'text' },
      { key: 'value', kind: 'code' },
      { key: 'unit', kind: 'text' },
    ],
    fields: [
      { key: 'itemId', kind: 'ref', ref: 'items', required: true },
      { key: 'kind', kind: 'select', options: [
        { value: 'gtin', labelKey: 'options.identifierKind.gtin' },
        { value: 'upc', labelKey: 'options.identifierKind.upc' },
        { value: 'ean', labelKey: 'options.identifierKind.ean' },
        { value: 'internal', labelKey: 'options.identifierKind.internal' },
      ], required: true },
      { key: 'value', kind: 'text', required: true },
      { key: 'unit', kind: 'text' },
    ],
  },
  {
    key: 'customer-item-refs',
    table: 'customer_item_refs',
    singularTitleKey: 'entities.customer-item-refs.singular',
    actorCols: true,
    groupKey: 'inventory',
    featureKey: 'customerPartNumbers',
    writePermission: 'items.manage',
    iconKey: 'package',
    orgScoped: true,
    orderBy: 'customer_id, customer_sku',
    hasActive: false,
    columns: [
      { key: 'customerId', kind: 'ref', ref: 'parties' },
      { key: 'itemId', kind: 'ref', ref: 'items' },
      { key: 'customerSku', kind: 'code' },
      { key: 'description', kind: 'text' },
    ],
    fields: [
      { key: 'customerId', kind: 'ref', ref: 'parties', required: true },
      { key: 'itemId', kind: 'ref', ref: 'items', required: true },
      { key: 'customerSku', kind: 'text', required: true },
      { key: 'description', kind: 'textarea' },
    ],
  },
  // --- Inventory -----------------------------------------------------------
  {
    // Stock locations — physical bins/zones under the `locations` dimension.
    key: 'stock-locations',
    table: 'stock_locations',
    singularTitleKey: 'entities.stock-locations.singular',
    rehomed: true, // lives as a tab on the Inventory module
    actorCols: true,
    groupKey: 'inventory',
    featureKey: 'inventory',
    iconKey: 'package',
    orgScoped: true,
    orderBy: 'location_id, code',
    hasActive: true,
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'locationId', kind: 'ref', ref: 'locations' },
      { key: 'kind', kind: 'text' },
      { key: 'parentId', kind: 'ref', ref: 'stock-locations' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'locationId', kind: 'ref', ref: 'locations', required: true },
      { key: 'code', kind: 'text', required: true },
      { key: 'kind', kind: 'select', options: STOCK_LOCATION_KINDS, keepDefault: true },
      { key: 'parentId', kind: 'ref', ref: 'stock-locations' },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    // Per-item costing profile — method, accounts, tracking, standard cost, and
    // reorder points. One per inventory item.
    key: 'item-inventory-profiles',
    table: 'item_inventory_profiles',
    rehomed: true, // lives as a Costing section on the item record
    // One profile per item (item_inventory_profiles_item_id_unique), so the
    // item is the import identity: re-imports dedupe instead of stacking a
    // second profile no UI can display.
    naturalKey: 'itemId',
    actorCols: true,
    groupKey: 'inventory',
    featureKey: 'inventory',
    iconKey: 'package',
    orgScoped: true,
    orderBy: 'item_id',
    hasActive: false,
    columns: [
      { key: 'itemId', kind: 'ref', ref: 'items' },
      { key: 'costingMethod', kind: 'text' },
      { key: 'tracking', kind: 'text' },
      { key: 'standardCost', kind: 'number' },
      { key: 'baseUnit', kind: 'text' },
    ],
    fields: [
      { key: 'itemId', kind: 'ref', ref: 'items', required: true, lockedOnEdit: true },
      { key: 'costingMethod', kind: 'select', options: COSTING_METHODS, keepDefault: true },
      { key: 'tracking', kind: 'select', options: INVENTORY_TRACKING, keepDefault: true },
      { key: 'assetAccountId', kind: 'ref', ref: 'accounts', required: true },
      { key: 'cogsAccountId', kind: 'ref', ref: 'accounts', required: true },
      { key: 'adjustmentAccountId', kind: 'ref', ref: 'accounts' },
      { key: 'varianceAccountId', kind: 'ref', ref: 'accounts' },
      { key: 'receivedNotBilledAccountId', kind: 'ref', ref: 'accounts' },
      { key: 'standardCost', kind: 'decimal' },
      { key: 'baseUnit', kind: 'text', keepDefault: true },
      { key: 'reorderPoint', kind: 'decimal' },
      { key: 'preferredStockLevel', kind: 'decimal' },
    ],
  },
  {
    // Bill of materials — components consumed to build an assembly item.
    // Generic single-row mutations are refused in web/lib/setup/write.ts
    // (bomCommandOnly): every change goes through PUT /api/inventory/bom with
    // a complete recipe, expected version, reason, and audit. Bulk migration
    // imports keep their own path in web/lib/data-io/setup-resources.ts.
    key: 'bom-components',
    table: 'bom_components',
    rehomed: true, // lives as a tab on the Inventory module
    actorCols: true,
    groupKey: 'inventory',
    featureKey: 'inventory',
    iconKey: 'package',
    orgScoped: true,
    orderBy: 'assembly_item_id, sort_order',
    hasActive: false,
    columns: [
      { key: 'assemblyItemId', kind: 'ref', ref: 'items' },
      { key: 'componentItemId', kind: 'ref', ref: 'items' },
      { key: 'quantityPer', kind: 'number' },
      { key: 'sortOrder', kind: 'number' },
      { key: 'effectiveFrom', kind: 'date' },
      { key: 'effectiveTo', kind: 'date' },
      { key: 'operationSeq', kind: 'number' },
      { key: 'scrapPct', kind: 'number' },
      { key: 'isByproduct', kind: 'boolean' },
    ],
    fields: [
      { key: 'assemblyItemId', kind: 'ref', ref: 'items', required: true },
      { key: 'componentItemId', kind: 'ref', ref: 'items', required: true },
      { key: 'quantityPer', kind: 'decimal', required: true },
      { key: 'sortOrder', kind: 'integer', keepDefault: true },
      { key: 'effectiveFrom', kind: 'date' },
      { key: 'effectiveTo', kind: 'date' },
      { key: 'operationSeq', kind: 'integer' },
      { key: 'scrapPct', kind: 'decimal' },
      { key: 'isByproduct', kind: 'boolean' },
    ],
  },
]
