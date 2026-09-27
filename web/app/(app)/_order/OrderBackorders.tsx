'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { fetchAction } from '@braedonsaunders/appkit-errors'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import { Button } from '@openbooks/ui'
import { readApiErrorMessage } from '@/lib/api-error'
import { useAppAction } from '@/lib/use-app-action'
import { fromQuantityUnits, toQuantityUnits } from '@/lib/order-cycle-math'
import { promptDialog } from '../../../lib/prompt'

interface BackorderLine {
  lineId: string
  lineNumber: number
  itemId: string
  quantity: string
  fulfilled: string
  cancelled: string
  open: string
}

const shown = (quantity: string) => fromQuantityUnits(toQuantityUnits(quantity))

/**
 * The sales-order drawer's Backorders tab: each stock line still owed with
 * its ordered, fulfilled, cancelled and open quantity, and a reasoned
 * cancel of the open remainder. Read and write go through
 * /api/sales-orders/[id]/backorders, which refuses while Fulfillment is off.
 */
export function OrderBackorders({
  orderId,
  itemLabel,
}: {
  orderId: string
  itemLabel: (itemId: string) => string
}) {
  const t = useTranslations('purchaseOrders.shared.backorders')
  const router = useRouter()
  const { busy, refusal, execute } = useAppAction()
  const [lines, setLines] = useState<BackorderLine[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const url = `/api/sales-orders/${orderId}/backorders`

  const load = useCallback(async () => {
    try {
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) {
        setLoadError(await readApiErrorMessage(res, t('loadFailed')))
        return
      }
      const body = (await res.json()) as { lines: BackorderLine[] }
      setLoadError(null)
      setLines(body.lines)
    } catch {
      setLoadError(t('loadFailed'))
    }
  }, [url, t])

  useEffect(() => {
    queueMicrotask(() => { void load() })
  }, [load])

  async function cancelRemainder(line: BackorderLine) {
    const reason = await promptDialog({
      title: t('cancelTitle', { line: line.lineNumber, open: shown(line.open) }),
      label: t('reasonLabel'),
      placeholder: t('reasonPlaceholder'),
      confirmLabel: t('cancelConfirm'),
    })
    if (!reason) return
    await execute(
      () =>
        fetchAction(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lineId: line.lineId, quantity: line.open, reason }),
        }),
      {
        fallbackMessage: t('cancelFailed'),
        successMessage: t('cancelled', { line: line.lineNumber }),
        onOk: async () => {
          await load()
          router.refresh()
        },
      },
    )
  }

  if (loadError) {
    return <p role="alert" className="px-1 py-6 text-sm text-red-700 dark:text-red-300">{loadError}</p>
  }
  if (!lines) {
    return <p role="status" className="px-1 py-6 text-sm text-slate-600 dark:text-slate-300">{t('loading')}</p>
  }
  return (
    <div className="space-y-3 p-1">
      <ActionAlert error={refusal} fallbackMessage={t('cancelFailed')} />
      {lines.length === 0 ? (
        <p className="px-1 py-6 text-sm text-slate-600 dark:text-slate-300">{t('empty')}</p>
      ) : (
        <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          {lines.map((line) => (
            <div key={line.lineId} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
              <span className="w-16 shrink-0 text-xs font-medium text-slate-500 dark:text-slate-400">
                {t('line', { line: line.lineNumber })}
              </span>
              <span className="min-w-40 flex-1 text-slate-900 dark:text-slate-100">{itemLabel(line.itemId)}</span>
              <span className="tabular-nums text-slate-600 dark:text-slate-300">
                {t('quantities', {
                  ordered: shown(line.quantity),
                  fulfilled: shown(line.fulfilled),
                  cancelled: shown(line.cancelled),
                })}
              </span>
              <strong className="tabular-nums text-slate-900 dark:text-slate-100">
                {t('open', { open: shown(line.open) })}
              </strong>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => cancelRemainder(line)}>
                {t('cancelRemainder')}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
