'use client'

import { useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button } from '@openbooks/ui'
import { PagedTable } from '@/components/paged-table'
import { readApiErrorMessage } from '@/lib/api-error'

export type ReplenishmentStatus = 'reorder' | 'covered' | 'no_reorder_point' | 'points_inverted'

export interface ReplenishmentRowView {
  itemId: string
  item: string
  unit: string
  onHand: string
  committed: string
  unallocated: string
  onOrder: string
  projected: string
  reorderPoint: string | null
  preferredStockLevel: string | null
  proposed: string
  status: ReplenishmentStatus
  vendorId: string | null
  vendor: string | null
}

const STATUS_VARIANT: Record<ReplenishmentStatus, 'warning' | 'secondary' | 'outline' | 'destructive'> = {
  reorder: 'warning',
  covered: 'secondary',
  no_reorder_point: 'outline',
  points_inverted: 'destructive',
}

/**
 * Replenishment proposal lines with their evidence, and the one action the
 * report offers: create draft purchase orders for the selected proposals,
 * one per vendor, through the ordinary purchase-order create. Each vendor's
 * order carries an idempotency key minted once per selection, so retrying
 * after a partial failure replays the orders already created instead of
 * duplicating them. A selected line with no vendor refuses the whole action
 * by name; nothing is skipped silently.
 */
export function ReplenishmentProposals({
  rows,
  orderSubsidiaryId,
  canOrder,
}: {
  rows: ReplenishmentRowView[]
  /** Null leaves the order's subsidiary unset (a single-entity organization). */
  orderSubsidiaryId: string | null
  canOrder: boolean
}) {
  const t = useTranslations('warehouse.replenishment')
  const router = useRouter()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const keys = useRef<{ signature: string; byVendor: Map<string, string> }>({ signature: '', byVendor: new Map() })
  const orderable = useMemo(() => new Set(rows.filter((row) => row.status === 'reorder').map((row) => row.itemId)), [rows])

  function toggle(id: string) {
    if (!orderable.has(id)) return
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll(ids: string[]) {
    const eligible = ids.filter((id) => orderable.has(id))
    setSelected((current) => (eligible.every((id) => current.has(id)) ? new Set() : new Set(eligible)))
  }

  /** One key per vendor for this exact selection; a changed selection is a new proposal set. */
  function idempotencyKey(vendorId: string): string {
    const signature = `${orderSubsidiaryId}|${[...selected].sort().join(',')}`
    if (keys.current.signature !== signature) keys.current = { signature, byVendor: new Map() }
    let key = keys.current.byVendor.get(vendorId)
    if (!key) {
      key = crypto.randomUUID()
      keys.current.byVendor.set(vendorId, key)
    }
    return key
  }

  async function createOrders() {
    const lines = rows.filter((row) => selected.has(row.itemId))
    const withoutVendor = lines.filter((row) => !row.vendorId)
    if (withoutVendor.length > 0) {
      toast.error(t('noVendor', { items: withoutVendor.map((row) => row.item).join(', ') }))
      return
    }
    const byVendor = new Map<string, ReplenishmentRowView[]>()
    for (const line of lines) byVendor.set(line.vendorId!, [...(byVendor.get(line.vendorId!) ?? []), line])
    setBusy(true)
    let created = 0
    try {
      for (const [vendorId, vendorLines] of byVendor) {
        const res = await fetch('/api/purchase-orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey(vendorId) },
          body: JSON.stringify({
            partyId: vendorId,
            ...(orderSubsidiaryId ? { subsidiaryId: orderSubsidiaryId } : {}),
            memo: t('memo'),
            lines: vendorLines.map((line) => ({ itemId: line.itemId, quantity: line.proposed, unit: line.unit })),
          }),
        })
        if (!res.ok) {
          const reason = await readApiErrorMessage(res, t('failed'))
          toast.error(t('refused', { vendor: vendorLines[0]!.vendor ?? '', reason, created }))
          return
        }
        created += 1
      }
      toast.success(t('created', { count: created }))
      router.push('/purchase-orders')
    } catch {
      toast.error(t('failed'))
    } finally {
      setBusy(false)
    }
  }

  const figure = (value: string | null) => <span className="tabular-nums">{value ?? '—'}</span>

  return (
    <PagedTable<ReplenishmentRowView>
      rows={rows}
      rowKey={(row) => row.itemId}
      pageSize={25}
      searchable
      emptyAsRow
      empty={<p className="text-sm text-slate-500 dark:text-slate-400">{t('empty')}</p>}
      toolbarAfter={canOrder ? (
        <div className="flex items-center gap-3">
          <span className="text-sm text-slate-500 dark:text-slate-400" aria-live="polite">
            {t('selected', { count: selected.size })}
          </span>
          <Button size="sm" disabled={busy || selected.size === 0} onClick={() => void createOrders()}>
            {t('createOrders')}
          </Button>
        </div>
      ) : undefined}
      selection={canOrder ? {
        getId: (row) => row.itemId,
        selectedIds: selected,
        onToggle: toggle,
        onToggleAll: toggleAll,
        disabled: busy,
      } : undefined}
      columns={[
        { key: 'item', header: t('columns.item'), cell: (row) => <span className="font-medium">{row.item}</span>, search: (row) => `${row.item} ${row.vendor ?? ''}` },
        { key: 'unit', header: t('columns.unit'), cell: (row) => row.unit },
        { key: 'onHand', header: t('columns.onHand'), align: 'right', cell: (row) => figure(row.onHand) },
        { key: 'committed', header: t('columns.committed'), align: 'right', cell: (row) => figure(row.committed) },
        { key: 'unallocated', header: t('columns.unallocated'), align: 'right', cell: (row) => figure(row.unallocated) },
        { key: 'onOrder', header: t('columns.onOrder'), align: 'right', cell: (row) => figure(row.onOrder) },
        { key: 'projected', header: t('columns.projected'), align: 'right', cell: (row) => figure(row.projected) },
        { key: 'reorderPoint', header: t('columns.reorderPoint'), align: 'right', cell: (row) => figure(row.reorderPoint) },
        { key: 'preferred', header: t('columns.preferred'), align: 'right', cell: (row) => figure(row.preferredStockLevel) },
        { key: 'proposed', header: t('columns.proposed'), align: 'right', cell: (row) => <span className="font-medium tabular-nums">{row.proposed}</span> },
        { key: 'vendor', header: t('columns.vendor'), cell: (row) => row.vendor ?? '—' },
        { key: 'status', header: t('columns.status'), cell: (row) => <Badge variant={STATUS_VARIANT[row.status]}>{t(`status.${row.status}`)}</Badge> },
      ]}
    />
  )
}
