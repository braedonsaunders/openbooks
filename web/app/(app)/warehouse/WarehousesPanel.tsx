'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Ban, CirclePlay, MoreHorizontal, Archive } from 'lucide-react'
import { Badge, Button, ContextMenu, useContextMenu, type ContextMenuEntry } from '@openbooks/ui'
import { PagedTable } from '@/components/paged-table'
import { readApiErrorMessage } from '@/lib/api-error'
import { mergeHref } from '@/lib/list-params'
import { promptDialog } from '@/lib/prompt'
import type { ReportDrillTarget } from '@/lib/report-drill'
import { ReportDrillLink } from '../reports/ReportDrillLink'

export type WarehouseStatus = 'draft' | 'active' | 'suspended' | 'retired'

export interface WarehouseTieOutRowView {
  warehouseId: string | null
  code: string | null
  name: string | null
  status: WarehouseStatus | null
  valueLabel: string
}

type Action = 'activate' | 'suspend' | 'retire'

const STATUS_VARIANT: Record<WarehouseStatus, 'success' | 'secondary' | 'outline' | 'destructive'> = {
  active: 'success',
  draft: 'secondary',
  suspended: 'destructive',
  retired: 'outline',
}

/**
 * Warehouses with their lifecycle status and the on-hand value each holds,
 * tied out against the inventory control accounts. Row click opens the
 * warehouse's setup drawer; the row menu moves it through its lifecycle.
 */
export function WarehousesPanel({
  rows,
  canManage,
  currentParams,
  layerTotalLabel,
  controlLabel,
  controlDrill,
  differenceLabel,
  differenceIsZero,
}: {
  rows: WarehouseTieOutRowView[]
  canManage: boolean
  currentParams: Record<string, string | string[] | undefined>
  layerTotalLabel: string
  controlLabel: string
  controlDrill: ReportDrillTarget | null
  differenceLabel: string
  differenceIsZero: boolean
}) {
  const t = useTranslations('warehouse')
  const router = useRouter()
  const menu = useContextMenu()
  const [menuRow, setMenuRow] = useState<WarehouseTieOutRowView | null>(null)
  const [busy, setBusy] = useState(false)

  async function transition(row: WarehouseTieOutRowView, action: Action) {
    if (!row.warehouseId) return
    let reason: string | null = null
    if (action !== 'activate') {
      reason = await promptDialog({
        title: t(`lifecycle.${action}.title`, { code: row.code ?? '' }),
        label: t('lifecycle.reason'),
        confirmLabel: t(`lifecycle.${action}.confirm`),
      })
      if (reason === null) return
    }
    setBusy(true)
    try {
      const res = await fetch(`/api/warehouses/${row.warehouseId}/lifecycle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, reason }),
      })
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, t('lifecycle.failed')))
        return
      }
      toast.success(t(`lifecycle.${action}.done`, { code: row.code ?? '' }))
      router.refresh()
    } catch {
      toast.error(t('lifecycle.failed'))
    } finally {
      setBusy(false)
    }
  }

  const menuItems: ContextMenuEntry[] = menuRow?.status
    ? [
        { key: 'activate', label: t('lifecycle.activate.action'), icon: CirclePlay, disabled: busy || !['draft', 'suspended'].includes(menuRow.status), onSelect: () => void transition(menuRow, 'activate') },
        { key: 'suspend', label: t('lifecycle.suspend.action'), icon: Ban, disabled: busy || menuRow.status !== 'active', onSelect: () => void transition(menuRow, 'suspend') },
        { key: 'separator', separator: true },
        { key: 'retire', label: t('lifecycle.retire.action'), icon: Archive, danger: true, disabled: busy || !['active', 'suspended'].includes(menuRow.status), onSelect: () => void transition(menuRow, 'retire') },
      ]
    : []

  return (
    <div className="space-y-3">
      <PagedTable<WarehouseTieOutRowView>
        rows={rows}
        rowKey={(row) => row.warehouseId ?? 'unassigned'}
        pageSize={15}
        emptyAsRow
        empty={<p className="text-sm text-slate-500 dark:text-slate-400">{t('warehouses.empty')}</p>}
        onRowClick={(row) => {
          if (row.warehouseId) router.push(mergeHref('/warehouse', currentParams, { warehouse: row.warehouseId }) as never)
        }}
        columns={[
          {
            key: 'code',
            header: t('warehouses.columns.code'),
            cell: (row) => <span className="font-medium">{row.code ?? t('warehouses.unassigned')}</span>,
          },
          { key: 'name', header: t('warehouses.columns.name'), cell: (row) => row.name ?? '—' },
          {
            key: 'status',
            header: t('warehouses.columns.status'),
            cell: (row) => (row.status ? <Badge variant={STATUS_VARIANT[row.status]}>{t(`status.${row.status}`)}</Badge> : '—'),
          },
          {
            key: 'value',
            header: t('warehouses.columns.value'),
            align: 'right',
            cell: (row) => <span className="tabular-nums">{row.valueLabel}</span>,
          },
          ...(canManage
            ? [{
                key: 'actions',
                header: <span className="sr-only">{t('warehouses.columns.actions')}</span>,
                align: 'right' as const,
                cell: (row: WarehouseTieOutRowView) =>
                  row.warehouseId ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t('warehouses.actionsFor', { code: row.code ?? '' })}
                      onClick={(event) => {
                        event.stopPropagation()
                        setMenuRow(row)
                        menu.openBelow(event.currentTarget)
                      }}
                    >
                      <MoreHorizontal size={16} />
                    </Button>
                  ) : null,
              }]
            : []),
        ]}
      />
      <dl className="grid grid-cols-1 gap-2 border-t border-slate-200 pt-3 text-sm sm:grid-cols-3 dark:border-slate-800">
        <div>
          <dt className="text-slate-500 dark:text-slate-400">{t('tieOut.layers')}</dt>
          <dd className="font-medium tabular-nums">{layerTotalLabel}</dd>
        </div>
        <div>
          <dt className="text-slate-500 dark:text-slate-400">{t('tieOut.control')}</dt>
          <dd className="font-medium tabular-nums">
            {controlDrill ? <ReportDrillLink target={controlDrill}>{controlLabel}</ReportDrillLink> : controlLabel}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500 dark:text-slate-400">{t('tieOut.difference')}</dt>
          <dd className={differenceIsZero ? 'font-medium tabular-nums text-emerald-700 dark:text-emerald-300' : 'font-medium tabular-nums text-red-700 dark:text-red-300'}>
            {differenceIsZero ? t('tieOut.tiesOut') : differenceLabel}
          </dd>
        </div>
      </dl>
      <ContextMenu open={menu.open} position={menu.position} items={menuItems} onClose={menu.close} />
    </div>
  )
}
