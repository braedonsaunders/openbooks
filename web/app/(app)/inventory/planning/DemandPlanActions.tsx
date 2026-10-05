'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'
import { readApiErrorMessage } from '@/lib/api-error'
import { confirmDialog } from '@/lib/confirm'

interface SuggestionRow {
  id: string
  supplierId: string | null
  action: 'buy' | 'transfer'
}

/**
 * The planning work queue's one-click remedies: run the plan, confirm every
 * suggestion, and turn every confirmed purchase into grouped purchase-order
 * drafts. Transfers convert from their own drawer, where the source
 * location is an explicit choice rather than a stale guess.
 */
export function DemandPlanActions({
  subsidiaryId,
  subsidiaries,
}: {
  subsidiaryId: string
  subsidiaries: { id: string; name: string }[]
}) {
  const t = useTranslations('planning')
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)

  async function readRows(status: string): Promise<SuggestionRow[]> {
    const res = await fetch(
      `/api/inventory/planning/suggestions?subsidiaryId=${subsidiaryId}&status=${status}`,
      { credentials: 'same-origin' },
    )
    if (!res.ok) throw new Error(await readApiErrorMessage(res, t('list.needsAttention')))
    return (await res.json()) as SuggestionRow[]
  }

  async function runPlan() {
    setBusy('run')
    try {
      const res = await fetch('/api/inventory/planning/runs', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ subsidiaryId }),
      })
      if (!res.ok) throw new Error(await readApiErrorMessage(res, t('run.title')))
      const run = (await res.json()) as { number: string }
      const rows = await readRows('open')
      toast.success(t('run.done', { number: run.number, count: rows.length }))
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('run.title'))
    } finally {
      setBusy(null)
    }
  }

  async function confirmAll() {
    setBusy('confirm')
    try {
      const rows = await readRows('suggested')
      for (const row of rows) {
        const res = await fetch(`/api/inventory/planning/suggestions/${row.id}/confirm`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
        if (!res.ok) throw new Error(await readApiErrorMessage(res, t('actions.confirmAll')))
      }
      toast.success(t('actions.confirmed', { count: rows.length }))
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('actions.confirmAll'))
    } finally {
      setBusy(null)
    }
  }

  async function convertBuys() {
    setBusy('convert')
    try {
      const rows = (await readRows('confirmed')).filter((row) => row.action === 'buy')
      if (rows.length === 0) {
        toast.success(t('list.allCaughtUp'))
        return
      }
      const suppliers = new Set(rows.map((row) => row.supplierId ?? '?'))
      const proceed = await confirmDialog({
        title: t('actions.convertAll'),
        message: t('actions.convertedOrders', { orders: suppliers.size }),
        confirmLabel: t('actions.convertAll'),
      })
      if (!proceed) return
      const res = await fetch('/api/inventory/planning/suggestions/bulk-convert', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subsidiaryId, lines: rows.map((row) => ({ id: row.id })) }),
      })
      if (!res.ok) throw new Error(await readApiErrorMessage(res, t('actions.convertAll')))
      const result = (await res.json()) as {
        purchaseOrders: unknown[]
        transfers: unknown[]
      }
      toast.success(
        result.transfers.length > 0
          ? `${t('actions.convertedOrders', { orders: result.purchaseOrders.length })} ${t('actions.convertedTransfers', { transfers: result.transfers.length })}`
          : t('actions.convertedOrders', { orders: result.purchaseOrders.length }),
      )
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('actions.convertAll'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-slate-500">
        {subsidiaries.find((entry) => entry.id === subsidiaryId)?.name ?? ''}
      </span>
      <Button variant="outline" disabled={busy !== null} onClick={confirmAll}>
        {busy === 'confirm' ? t('run.running') : t('actions.confirmAll')}
      </Button>
      <Button variant="outline" disabled={busy !== null} onClick={convertBuys}>
        {busy === 'convert' ? t('run.running') : t('actions.convertAll')}
      </Button>
      <Button disabled={busy !== null} onClick={runPlan}>
        {busy === 'run' ? t('run.running') : t('run.start')}
      </Button>
    </div>
  )
}
