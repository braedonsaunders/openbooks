import 'server-only'

import { getTranslations } from 'next-intl/server'
import {
  column,
  field,
  heading,
  link,
  ref,
  rootRef,
  table,
  text,
  textBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { isZero } from '@openbooks/engine/src/money/money.ts'
import {
  AvailabilityRefusal,
  listAvailableToPromise,
  releasableBackorders,
  type AvailableToPromise,
  type ReleasableBackorder,
} from '@openbooks/engine/src/inventory/availability.ts'
import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { isFeatureEnabled } from '../../../../lib/features'
import { orgInfo } from '../../../../lib/data'
import { pickString } from '../../../../lib/list-params'
import { statementReportSpec } from '@/lib/reports/statement-report-spec'
import {
  availabilityEntityScope,
  availabilityRefusalText,
  availabilityWarehouseOptions,
} from '../../../../lib/availability-report'

/**
 * Availability, split into a loader and a spec like the balance sheet: the
 * figures ARE engine math, so the loader calls the availability engine and
 * the page only lays out its terms. One row per stocked item for the chosen
 * legal entity, optionally narrowed to one warehouse, with every term shown:
 * on hand, committed, available and unallocated demand. While Fulfillment is
 * on, the open order lines that stock on hand could ship now follow, each
 * linking to its order.
 */

export interface AvailabilityRow {
  itemId: string
  item: string
  unit: string
  onHand: string
  committed: string
  available: string
  unallocated: string
}

export interface ReleasableRow {
  lineId: string
  order: string
  orderHref: string
  date: string
  customer: string
  item: string
  unit: string
  open: string
  releasable: string
}

export interface AvailabilityData {
  title: string
  description: string
  backHref: string
  backLabel: string
  company: string
  scopePhrase: string
  note: string
  searchPlaceholder: string
  /** A refusal the engine raised instead of figures, with its remedy. */
  refusal: string | null
  subsidiaries: { id: string; label: string }[]
  primaryFilter: { paramKey: string; label: string; value: string; options: { value: string; label: string }[] }
  exportParams: Record<string, string | undefined>
  columns: Record<'item' | 'unit' | 'onHand' | 'committed' | 'available' | 'unallocated', string>
  rows: AvailabilityRow[]
  empty: string
  showReleasable: boolean
  releasableTitle: string
  releasableNote: string
  releasableColumns: Record<'order' | 'date' | 'customer' | 'item' | 'unit' | 'open' | 'releasable', string>
  releasable: ReleasableRow[]
  releasableEmpty: string
}

export async function loadAvailability(sp: Record<string, string | undefined>): Promise<AvailabilityData> {
  const authz = await requirePermission('items.read')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'warehousing')
  const t = await getTranslations('warehouse.availability')
  const tr = await getTranslations('reports')

  const warehouses = await availabilityWarehouseOptions(orgId)
  const requestedWarehouse = pickString(sp.warehouse)
  const warehouse = warehouses.find((option) => option.id === requestedWarehouse) ?? null
  const entity = await availabilityEntityScope(authz, pickString(sp.sub))
  const search = (pickString(sp.q) ?? '').trim().toLocaleLowerCase()
  const showZero = sp.zero === '1'
  const fulfillmentOn = await isFeatureEnabled(orgId, 'fulfillment')

  let terms: AvailableToPromise[] = []
  let backorders: ReleasableBackorder[] = []
  let refusal: string | null = null
  if (entity.selectedId) {
    const query = { subsidiaryId: entity.selectedId, warehouseId: warehouse?.id ?? null }
    try {
      terms = await listAvailableToPromise(db, orgId, query)
      if (fulfillmentOn) backorders = await releasableBackorders(db, orgId, query)
    } catch (error) {
      if (!(error instanceof AvailabilityRefusal)) throw error
      refusal = availabilityRefusalText(error)
    }
  }
  const rows = terms
    .filter((row) => !search || row.itemLabel.toLocaleLowerCase().includes(search))
    .filter((row) => showZero || ![row.onHand, row.committed, row.unallocated].every(isZero))
    .map((row) => ({
      itemId: row.itemId,
      item: row.itemLabel,
      unit: row.baseUnit,
      onHand: row.onHand,
      committed: row.committed,
      available: row.available,
      unallocated: row.unallocated,
    }))
  const releasable = backorders
    .filter((line) => !search || line.itemLabel.toLocaleLowerCase().includes(search))
    .map((line) => ({
      lineId: line.lineId,
      order: t('releasable.orderLine', { number: line.documentNumber, line: line.lineNumber }),
      orderHref: `/sales-orders?order=${line.documentId}`,
      date: line.documentDate,
      customer: line.customerName ?? '—',
      item: line.itemLabel,
      unit: line.baseUnit,
      open: line.openBase,
      releasable: line.releasable,
    }))

  const entityLabel = entity.picker.find((option) => option.id === entity.selectedId)?.label ?? ''
  const org = await orgInfo(orgId)
  return {
    title: t('title'),
    description: t('description'),
    backHref: '/reports',
    backLabel: tr('hub.title'),
    company: org?.name ?? '',
    scopePhrase: [entityLabel, warehouse?.label ?? t('allLocations')].filter(Boolean).join(' · '),
    note: t('note'),
    searchPlaceholder: t('search'),
    refusal,
    subsidiaries: entity.picker,
    primaryFilter: {
      paramKey: 'warehouse',
      label: t('warehouse'),
      value: warehouse?.id ?? '',
      options: [{ value: '', label: t('allLocations') }, ...warehouses.map((option) => ({ value: option.id, label: option.label }))],
    },
    exportParams: sp,
    columns: {
      item: t('columns.item'),
      unit: t('columns.unit'),
      onHand: t('columns.onHand'),
      committed: t('columns.committed'),
      available: t('columns.available'),
      unallocated: t('columns.unallocated'),
    },
    rows,
    empty: t('empty'),
    showReleasable: fulfillmentOn,
    releasableTitle: t('releasable.title'),
    releasableNote: t('releasable.note'),
    releasableColumns: {
      order: t('releasable.columns.order'),
      date: t('releasable.columns.date'),
      customer: t('releasable.columns.customer'),
      item: t('columns.item'),
      unit: t('columns.unit'),
      open: t('releasable.columns.open'),
      releasable: t('releasable.columns.releasable'),
    },
    releasable,
    releasableEmpty: t('releasable.empty'),
  }
}

const f = ref<AvailabilityData>()
const rootF = rootRef<AvailabilityData>()
const item = field
const quantity = (name: string, header: Parameters<typeof column>[0]) =>
  column(header, text(item(name)), { align: 'right', className: 'tabular-nums' })

export function availabilitySpec(data: AvailabilityData): PageSpec {
  return statementReportSpec({
    route: '/reports/availability',
    header: {
      title: f('title'),
      description: f('description'),
      back: { href: f('backHref'), label: f('backLabel') },
    },
    headerBeforeFilters: [textBlock(f('refusal'), { tone: 'warning', when: f('refusal') })],
    filters: [{
      controls: { search: true, subsidiary: true, showZero: true },
      options: {
        searchPlaceholder: f('searchPlaceholder'),
        subsidiaries: f('subsidiaries'),
        primaryFilter: f('primaryFilter'),
      },
    }],
    exportMenu: { kind: 'availability', params: data.exportParams },
    paper: {
      company: f('company'),
      title: f('title'),
      periodPhrase: f('scopePhrase'),
      wide: true,
    },
    blocks: [
      table({
        variant: 'report',
        rows: f('rows'),
        rowKey: item('itemId'),
        emptyRow: { text: f('empty'), colSpan: 6 },
        columns: [
          column(rootF('columns.item'), text(item('item')), { className: 'font-medium' }),
          column(rootF('columns.unit'), text(item('unit'))),
          quantity('onHand', rootF('columns.onHand')),
          quantity('committed', rootF('columns.committed')),
          quantity('available', rootF('columns.available')),
          quantity('unallocated', rootF('columns.unallocated')),
        ],
      }),
      textBlock(f('note'), { tone: 'muted', className: 'mt-3' }),
      { ...heading(3, f('releasableTitle'), 'mt-8 mb-2'), when: f('showReleasable') },
      table({
        variant: 'report',
        when: f('showReleasable'),
        rows: f('releasable'),
        rowKey: item('lineId'),
        emptyRow: { text: f('releasableEmpty'), colSpan: 7 },
        columns: [
          column(rootF('releasableColumns.order'), link(item('order'), item('orderHref')), { className: 'font-medium' }),
          column(rootF('releasableColumns.date'), text(item('date')), { className: 'tabular-nums' }),
          column(rootF('releasableColumns.customer'), text(item('customer'))),
          column(rootF('releasableColumns.item'), text(item('item'))),
          column(rootF('releasableColumns.unit'), text(item('unit'))),
          quantity('open', rootF('releasableColumns.open')),
          quantity('releasable', rootF('releasableColumns.releasable')),
        ],
      }),
      textBlock(f('releasableNote'), { tone: 'muted', className: 'mt-3', when: f('showReleasable') }),
    ],
  })
}
