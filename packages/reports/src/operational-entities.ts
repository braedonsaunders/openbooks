import type { ReportEntity } from './entities'

/** Scoped operational sources for native portfolio and control reports. */
export const OPERATIONAL_REPORT_ENTITIES: ReportEntity[] = [
  {
    key: 'manufacturing_work_orders', label: 'Manufacturing work orders', category: 'inventory',
    description: 'Production order lifecycle by subsidiary. Counts describe orders, not quantities across different units.',
    from: 'mfg_work_orders wo', orgColumn: 'wo.org_id', subsidiaryScope: { column: 'wo.subsidiary_id' },
    featureKey: 'manufacturing', requiredPermission: 'manufacturing.read',
    columns: [
      { key: 'number', label: 'Order number', kind: 'text', expr: 'wo.number' },
      { key: 'status', label: 'Status', kind: 'enum', expr: 'wo.status', options: ['draft', 'released', 'in_progress', 'on_hold', 'done', 'closed', 'cancelled'] },
      { key: 'planned_start', label: 'Planned start', kind: 'date', expr: 'wo.planned_start' },
      { key: 'planned_end', label: 'Planned end', kind: 'date', expr: 'wo.planned_end' },
    ],
  },
  {
    key: 'managed_property_portfolio', label: 'Managed properties', category: 'catalog',
    description: 'Current portfolio lifecycle, scoped to the reader’s legal entities.',
    from: 'managed_properties mp', orgColumn: 'mp.org_id', subsidiaryScope: { column: 'mp.subsidiary_id' },
    featureKey: 'propertyManagement', requiredPermission: 'ar.read',
    columns: [
      { key: 'code', label: 'Property code', kind: 'text', expr: 'mp.code' },
      { key: 'name', label: 'Property', kind: 'text', expr: 'mp.name' },
      { key: 'status', label: 'Status', kind: 'enum', expr: 'mp.status', options: ['active', 'inactive', 'sold'] },
    ],
  },
]
