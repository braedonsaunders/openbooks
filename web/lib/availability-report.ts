import 'server-only'

import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { isZero } from '@openbooks/engine/src/money/money.ts'
import { listWarehouses } from '@openbooks/engine/src/inventory/warehouses.ts'
import {
  listAvailableToPromise,
  releasableBackorders,
  type AvailabilityRefusal,
} from '@openbooks/engine/src/inventory/availability.ts'
import { replenishmentProposals } from '@openbooks/engine/src/inventory/replenishment.ts'
import type { Authz } from './authz'
import { isFeatureEnabled } from './features'
import type { ExportData } from './report-pdf'
import { subsidiaryOptions } from './subsidiaries'

/**
 * The legal entities a reader may measure availability for, and the one
 * selected. Stock layers and reorder points belong to one entity, so the
 * Availability and Replenishment reports and their assistant tools read one
 * entity at a time: the requested one when the reader can see it, otherwise
 * the root entity, otherwise the first entity in the reader's scope. The
 * picker lists the default first, because the filter bar writes no parameter
 * for its first option. `selectedId` is null only when the reader can see no
 * entity at all.
 */
export async function availabilityEntityScope(
  authz: Authz,
  requested: string | undefined,
): Promise<{ selectedId: string | null; picker: { id: string; label: string }[] }> {
  const allowed = authz.allowedSubsidiaryIds
  const visible = (await subsidiaryOptions(false, false, authz.user.orgId))
    .filter((subsidiary) => !allowed || allowed.has(subsidiary.id))
  const fallback = visible.find((subsidiary) => subsidiary.parentId === null) ?? visible[0] ?? null
  const selected = visible.find((subsidiary) => subsidiary.id === requested) ?? fallback
  const ordered = fallback ? [fallback, ...visible.filter((subsidiary) => subsidiary.id !== fallback.id)] : []
  return {
    selectedId: selected?.id ?? null,
    picker: ordered.map((subsidiary) => ({ id: subsidiary.id, label: subsidiary.name })),
  }
}

/** Warehouses a report can be narrowed to, by code; retired ones keep their history. */
export async function availabilityWarehouseOptions(orgId: string): Promise<{ id: string; label: string }[]> {
  return (await listWarehouses(db, orgId)).map((warehouse) => ({
    id: warehouse.id,
    label: `${warehouse.code} · ${warehouse.name}`,
  }))
}

/**
 * An availability refusal as the operator reads it on a page: what is wrong
 * and the remedy, once. Pages render it in place of figures they could not
 * compute rather than letting it become an anonymous error page.
 */
export function availabilityRefusalText(error: AvailabilityRefusal): string {
  return error.message.includes(error.remedy) ? error.message : `${error.message}; ${error.remedy}`
}

const RIGHT = 'right' as const

/**
 * The Availability report as export content: the same engine read and the
 * same filters (entity, warehouse, item search, zero rows) as the page.
 */
export async function availabilityExportData(authz: Authz, p: URLSearchParams): Promise<ExportData> {
  const orgId = authz.user.orgId
  const t = await getTranslations('warehouse.availability')
  const entity = await availabilityEntityScope(authz, p.get('sub') ?? undefined)
  const warehouses = await availabilityWarehouseOptions(orgId)
  const warehouse = warehouses.find((option) => option.id === p.get('warehouse')) ?? null
  const search = (p.get('q') ?? '').trim().toLocaleLowerCase()
  const showZero = p.get('zero') === '1'
  const query = { subsidiaryId: entity.selectedId ?? '', warehouseId: warehouse?.id ?? null }
  const terms = entity.selectedId ? await listAvailableToPromise(db, orgId, query) : []
  const releasable = entity.selectedId && (await isFeatureEnabled(orgId, 'fulfillment'))
    ? await releasableBackorders(db, orgId, query)
    : null
  const matches = (label: string) => !search || label.toLocaleLowerCase().includes(search)
  const entityLabel = entity.picker.find((option) => option.id === entity.selectedId)?.label ?? ''
  const columns = [t('columns.item'), t('columns.unit'), t('columns.onHand'), t('columns.committed'), t('columns.available'), t('columns.unallocated')]
  return {
    title: t('title'),
    dateRangeLabel: [entityLabel, warehouse?.label ?? t('allLocations')].filter(Boolean).join(' · '),
    summary: [],
    groups: [
      {
        kind: 'results',
        title: t('title'),
        columns,
        align: ['left', 'left', RIGHT, RIGHT, RIGHT, RIGHT],
        rows: terms
          .filter((row) => matches(row.itemLabel))
          .filter((row) => showZero || ![row.onHand, row.committed, row.unallocated].every(isZero))
          .map((row) => [row.itemLabel, row.baseUnit, row.onHand, row.committed, row.available, row.unallocated]),
      },
      ...(releasable
        ? [{
            kind: 'section' as const,
            title: t('releasable.title'),
            columns: [
              t('releasable.columns.order'), t('releasable.columns.date'), t('releasable.columns.customer'),
              t('columns.item'), t('columns.unit'), t('releasable.columns.open'), t('releasable.columns.releasable'),
            ],
            align: ['left', 'left', 'left', 'left', 'left', RIGHT, RIGHT] as ('left' | 'right')[],
            rows: releasable
              .filter((line) => matches(line.itemLabel))
              .map((line) => [
                t('releasable.orderLine', { number: line.documentNumber, line: line.lineNumber }),
                line.documentDate, line.customerName ?? '', line.itemLabel, line.baseUnit, line.openBase, line.releasable,
              ]),
          }]
        : []),
    ],
  }
}

/** The Replenishment report as export content, with every line's evidence. */
export async function replenishmentExportData(authz: Authz, p: URLSearchParams): Promise<ExportData> {
  const t = await getTranslations('warehouse.replenishment')
  const entity = await availabilityEntityScope(authz, p.get('sub') ?? undefined)
  const search = (p.get('q') ?? '').trim().toLocaleLowerCase()
  const lines = entity.selectedId ? await replenishmentProposals(db, authz.user.orgId, { subsidiaryId: entity.selectedId }) : []
  return {
    title: t('title'),
    dateRangeLabel: entity.picker.find((option) => option.id === entity.selectedId)?.label ?? '',
    summary: [],
    groups: [{
      kind: 'results',
      title: t('title'),
      columns: [
        t('columns.item'), t('columns.unit'), t('columns.onHand'), t('columns.committed'), t('columns.unallocated'),
        t('columns.onOrder'), t('columns.projected'), t('columns.reorderPoint'), t('columns.preferred'),
        t('columns.proposed'), t('columns.vendor'), t('columns.status'),
      ],
      align: ['left', 'left', RIGHT, RIGHT, RIGHT, RIGHT, RIGHT, RIGHT, RIGHT, RIGHT, 'left', 'left'],
      rows: lines
        .filter((line) => !search || line.itemLabel.toLocaleLowerCase().includes(search))
        .map((line) => [
          line.itemLabel, line.baseUnit, line.onHand, line.committed, line.unallocated, line.onOrder, line.projected,
          line.reorderPoint ?? '', line.preferredStockLevel ?? '', line.proposed, line.vendorName ?? '', t(`status.${line.status}`),
        ]),
    }],
  }
}
