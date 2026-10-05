'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Badge, Button, EmptyState } from '@openbooks/ui'
import { readApiErrorMessage } from '@/lib/api-error'
import { LineGrid, type LineGridColumn } from '../../../components/line-grid'
import { trimKitQty } from './kit-component-labels'

interface AvailabilityComponent {
  itemId: string
  itemLabel: string
  onHand: string
  committed: string
  available: string
}

interface KitAvailability {
  itemId: string
  allLocations: {
    kit: { itemId: string; itemLabel: string; onHand: string; committed: string; available: string } | null
    components: (AvailabilityComponent | null)[]
  }
  warehouses: {
    warehouseId: string
    warehouseCode: string
    kit: { itemId: string; itemLabel: string; onHand: string; committed: string; available: string } | null
    components: (AvailabilityComponent | null)[]
  }[]
}

/**
 * A kit's per-warehouse availability: what every location can still sell.
 * Lives on its own drawer tab beside Components — a second concept table
 * cannot sit inside the recipe's disclosure and stay findable.
 */
export function KitAvailabilityTab({ itemId }: { itemId: string }) {
  const t = useTranslations('items')
  const tCommon = useTranslations('common')
  const [availability, setAvailability] = useState<KitAvailability | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch(`/api/items/${encodeURIComponent(itemId)}/kit-availability`, { cache: 'no-store' })
      if (!res.ok) {
        setLoadError(await readApiErrorMessage(res, t('kit.loadFailed')))
        setLoading(false)
        return
      }
      setAvailability((await res.json()) as KitAvailability)
    } catch {
      setLoadError(t('kit.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [itemId, t])

  useEffect(() => {
    queueMicrotask(() => { void load() })
  }, [load])

  // Rows key on storage identity, never display labels: two items can
  // share a name and two locations a code, but warehouse and item ids are
  // unique per measured stock row.
  const rows = useMemo(() => {
    if (!availability) return []
    return availability.warehouses.flatMap((warehouse) =>
      (warehouse.kit
        ? [{
            warehouseId: warehouse.warehouseId,
            warehouse: warehouse.warehouseCode,
            ...warehouse.kit,
          }]
        : []
      ).concat(
        warehouse.components
          .filter((component) => component !== null)
          .map((component) => ({
            warehouseId: warehouse.warehouseId,
            warehouse: warehouse.warehouseCode,
            ...component!,
          })),
      ),
    )
  }, [availability])

  const columns = useMemo<
    LineGridColumn<{ warehouseId: string; warehouse: string; itemId: string; itemLabel: string; onHand: string; committed: string; available: string }>[]
  >(
    () => [
      { key: 'warehouse', label: tCommon('labels.warehouse'), width: '110px', type: 'readonly' },
      { key: 'itemLabel', label: tCommon('labels.item'), width: 'minmax(170px,1fr)', type: 'readonly' },
      { key: 'onHand', label: t('kit.onHand'), width: '100px', type: 'readonly', align: 'right', render: (row) => trimKitQty(row.onHand) },
      { key: 'committed', label: t('kit.committed'), width: '100px', type: 'readonly', align: 'right', render: (row) => trimKitQty(row.committed) },
      { key: 'available', label: t('kit.available'), width: '100px', type: 'readonly', align: 'right', render: (row) => trimKitQty(row.available) },
    ],
    [t, tCommon],
  )

  if (loading) {
    return <p role="status" className="py-4 text-sm text-slate-600 dark:text-slate-300">{t('kit.availabilityLoading')}</p>
  }
  if (loadError || !availability) {
    return (
      <div role="alert" className="space-y-3 py-4">
        <p className="text-sm text-red-700 dark:text-red-300">{loadError ?? t('kit.loadFailed')}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => { void load() }}>
          {tCommon('actions.retry')}
        </Button>
      </div>
    )
  }

  const available = availability.allLocations.kit?.available
  if (rows.length === 0) {
    return (
      <EmptyState
        title={t('kit.availabilityTitle')}
        description={available !== undefined ? t('kit.availabilitySummary', { count: trimKitQty(available) }) : t('kit.noRecipeSummary')}
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {available !== undefined ? (
          <Badge variant="success">{t('kit.availabilitySummary', { count: trimKitQty(available) })}</Badge>
        ) : null}
      </div>
      <LineGrid
        columns={columns}
        rows={rows}
        onRowsChange={() => undefined}
        emptyRow={() => ({ warehouseId: '', warehouse: '', itemId: '', itemLabel: '', onHand: '', committed: '', available: '' })}
        getRowKey={(row) => `${row.warehouseId}:${row.itemId}`}
        readOnly
      />
    </div>
  )
}
