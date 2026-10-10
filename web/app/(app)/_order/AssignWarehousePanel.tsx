'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Label, Select } from '@openbooks/ui'
import { fetchAction } from '@braedonsaunders/appkit-errors'

/**
 * Per-line warehouse assignment after a convert refusal. Lists every stocked
 * line still missing a warehouse with the entity's active warehouses and
 * posts each choice to the order's assign-warehouse endpoint (approved
 * orders are storage-immutable, so the draft edit path cannot take it).
 * The parent reloads behind every success; the operator converts again
 * once the lines name their warehouses.
 */
export function AssignWarehousePanel({
  lines,
  warehouses,
  assignUrl,
  getRevision,
  onAssigned,
  disabled = false,
}: {
  lines: { persistedLineId: string; description: string }[]
  warehouses: { id: string; code: string | null }[]
  assignUrl: string
  getRevision: () => string
  onAssigned: () => void
  disabled?: boolean
}) {
  const t = useTranslations('purchaseOrders.shared')
  const tCommon = useTranslations('common')
  const [choices, setChoices] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  async function assign(persistedLineId: string) {
    const stockLocationId = choices[persistedLineId] ?? ''
    if (!stockLocationId || busyId) return
    setBusyId(persistedLineId)
    setErrors((prev) => ({ ...prev, [persistedLineId]: '' }))
    try {
      const result = await fetchAction<{ doc?: { updated_at?: unknown } }>(assignUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineId: persistedLineId, stockLocationId, expectedUpdatedAt: getRevision() }),
      })
      if (!result.ok) {
        const message = result.error.serverMessage?.trim()
          ? result.error.serverMessage
          : t('assignWarehouseFailed')
        setErrors((prev) => ({ ...prev, [persistedLineId]: message }))
        toast.error(message)
        return
      }
      toast.success(t('assignWarehouseDone'))
      setChoices((prev) => {
        const next = { ...prev }
        delete next[persistedLineId]
        return next
      })
      onAssigned()
    } finally {
      setBusyId(null)
    }
  }

  if (lines.length === 0) return null
  return (
    <section aria-label={t('assignWarehouseTitle')} className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('assignWarehouseTitle')}</h3>
      {lines.map((line) => {
        const error = errors[line.persistedLineId] ?? ''
        return (
          <div key={line.persistedLineId} className="flex flex-wrap items-end gap-2">
            <div className="min-w-40 flex-1">
              <Label>{line.description || tCommon('labels.description')}</Label>
              <Select
                aria-label={`${t('assignWarehouseLabel')} — ${line.description}`}
                value={choices[line.persistedLineId] ?? ''}
                disabled={disabled || busyId !== null}
                onChange={(event) => setChoices((prev) => ({ ...prev, [line.persistedLineId]: event.target.value }))}
                triggerClassName="h-8"
              >
                <option value="">—</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>{w.code ?? w.id}</option>
                ))}
              </Select>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || busyId !== null || !(choices[line.persistedLineId] ?? '')}
              onClick={() => assign(line.persistedLineId)}
            >
              {busyId === line.persistedLineId ? tCommon('actions.saving') : t('assignWarehouseApply')}
            </Button>
            {error ? <p role="alert" className="w-full text-xs text-red-600 dark:text-red-400">{error}</p> : null}
          </div>
        )
      })}
    </section>
  )
}
