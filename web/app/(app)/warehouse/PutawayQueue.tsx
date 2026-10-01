'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'
import { useBusinessToday } from '@/components/business-date-provider'
import { PagedTable } from '@/components/paged-table'
import { readApiErrorMessage } from '@/lib/api-error'

export interface StagedStockRowView {
  warehouseId: string
  warehouseCode: string
  stagingLocationId: string
  stagingCode: string
  itemId: string
  itemLabel: string
  subsidiaryId: string
  quantity: string
}

const rowId = (row: StagedStockRowView) => `${row.stagingLocationId}:${row.itemId}:${row.subsidiaryId}`

/**
 * Stock waiting in staging locations. "Put away" moves the whole staged
 * quantity to the location the warehouse's putaway rules resolve; a refusal
 * names every rule tried. One retry identity per row and quantity, so a lost
 * response replays instead of moving the stock twice.
 */
export function PutawayQueue({ rows, canPost }: { rows: StagedStockRowView[]; canPost: boolean }) {
  const t = useTranslations('warehouse')
  const router = useRouter()
  const [busyRow, setBusyRow] = useState<string | null>(null)
  const [postingDate] = useState(useBusinessToday())
  const retryKeys = useRef(new Map<string, string>())

  async function putAway(row: StagedStockRowView) {
    const identity = `${rowId(row)}:${row.quantity}:${postingDate}`
    const idempotencyKey = retryKeys.current.get(identity) ?? crypto.randomUUID()
    retryKeys.current.set(identity, idempotencyKey)
    setBusyRow(rowId(row))
    try {
      const res = await fetch(`/api/warehouses/${row.warehouseId}/putaway`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stagingLocationId: row.stagingLocationId,
          itemId: row.itemId,
          subsidiaryId: row.subsidiaryId,
          quantity: row.quantity,
          idempotencyKey,
          date: postingDate,
        }),
      })
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, t('putaway.failed')))
        return
      }
      const moved = (await res.json()) as { code: string }
      retryKeys.current.delete(identity)
      toast.success(t('putaway.done', { item: row.itemLabel, bin: moved.code }))
      router.refresh()
    } catch {
      toast.error(t('putaway.failed'))
    } finally {
      setBusyRow(null)
    }
  }

  return (
    <PagedTable<StagedStockRowView>
      source="warehouse_putaway"
      rows={rows}
      rowKey={rowId}
      searchable
      pageSize={10}
      emptyAsRow
      empty={<p className="text-sm text-slate-500 dark:text-slate-400">{t('putaway.empty')}</p>}
      columns={[
        { key: 'warehouse', header: t('putaway.columns.warehouse'), cell: (row) => row.warehouseCode, search: (row) => row.warehouseCode },
        { key: 'staging', header: t('putaway.columns.staging'), cell: (row) => row.stagingCode, search: (row) => row.stagingCode },
        { key: 'item', header: t('putaway.columns.item'), cell: (row) => <span className="font-medium">{row.itemLabel}</span>, search: (row) => row.itemLabel },
        { key: 'quantity', header: t('putaway.columns.quantity'), align: 'right', cell: (row) => <span className="tabular-nums">{row.quantity}</span> },
        ...(canPost
          ? [{
              key: 'action',
              header: <span className="sr-only">{t('putaway.columns.action')}</span>,
              align: 'right' as const,
              cell: (row: StagedStockRowView) => (
                <Button size="sm" variant="outline" disabled={busyRow !== null} onClick={() => void putAway(row)}>
                  {t('putaway.action')}
                </Button>
              ),
            }]
          : []),
      ]}
    />
  )
}
