'use client'

import * as React from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useTranslations } from 'next-intl'
import { Button, FieldLabel, Input } from '@openbooks/ui'

export interface ReceiptPrefillLine {
  sourceLineId: string
  lineNumber: number
  description: string | null
  unit: string | null
  unitPrice: string
  remaining: string
  stockLocationId: string | null
}

export interface ReceiptSaveInput {
  receiptDate: string
  lines: { sourceLineId: string; quantity: string }[]
  idempotencyKey: string
}

export type ReceiptSaveOutcome = { ok: true } | { ok: false; message: string }

interface GoodsReceiptFormProps {
  orderId: string
  apiBase: string
  warehouses: { id: string; code: string | null }[]
  /** Save through the drawer's action path (pins typed refusals, offers
   * warehouse assignment). The form keeps its state on failure so Save
   * retries with the same idempotency key and replays instead of doubling. */
  onSubmit: (input: ReceiptSaveInput) => Promise<ReceiptSaveOutcome>
  onClose: () => void
}

type Prefill = { receiptDate: string; lines: ReceiptPrefillLine[] }

/**
 * Goods-receipt draft for a purchase order. Prefilled from the order (every
 * stock line's remaining quantity, receipt date defaulting to today in the
 * org's business calendar, warehouse per line defaulted per the entity
 * default) and posted only on explicit Save through the native receive path.
 * Partial quantities save what was entered; nothing posts on open or close.
 */
export function GoodsReceiptForm({ orderId, apiBase, warehouses, onSubmit, onClose }: GoodsReceiptFormProps) {
  const t = useTranslations('purchaseOrders.shared')
  const tCommon = useTranslations('common')
  const [prefill, setPrefill] = React.useState<Prefill | null>(null)
  const [prefillFailed, setPrefillFailed] = React.useState(false)
  const [reloadNonce, setReloadNonce] = React.useState(0)
  const [receiptDate, setReceiptDate] = React.useState('')
  const [quantities, setQuantities] = React.useState<Record<string, string>>({})
  const [inlineError, setInlineError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)
  // One command identity per form opening: a failed save retried with the
  // same key replays the stored receipt instead of receiving twice.
  const [idempotencyKey] = React.useState(() => crypto.randomUUID())

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      setPrefillFailed(false)
      try {
        const res = await fetch(`${apiBase}/${orderId}/receive`)
        if (!res.ok || cancelled) {
          if (!cancelled) setPrefillFailed(true)
          return
        }
        const data = (await res.json()) as Partial<Prefill>
        if (cancelled) return
        if (typeof data.receiptDate !== 'string' || !Array.isArray(data.lines)) {
          setPrefillFailed(true)
          return
        }
        setPrefill(data as Prefill)
        setReceiptDate(data.receiptDate)
        setQuantities(Object.fromEntries(data.lines.map((line) => [line.sourceLineId, line.remaining])))
      } catch {
        if (!cancelled) setPrefillFailed(true)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [apiBase, orderId, reloadNonce])

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  const warehouseById = React.useMemo(() => new Map(warehouses.map((w) => [w.id, w.code ?? w.id])), [warehouses])

  async function save() {
    if (!prefill || saving) return
    for (const line of prefill.lines) {
      const raw = (quantities[line.sourceLineId] ?? '').trim()
      if (raw === '') continue
      const qty = Number(raw)
      if (!Number.isFinite(qty) || qty <= 0) {
        setInlineError(t('invalidLineSave', { row: line.lineNumber, field: t('receive.receiveQty') }))
        return
      }
      if (qty > Number(line.remaining)) {
        setInlineError(t('receive.overReceive', { line: line.lineNumber, qty: raw, remaining: line.remaining }))
        return
      }
    }
    const lines = prefill.lines.flatMap((line) => {
      const raw = (quantities[line.sourceLineId] ?? '').trim()
      if (raw === '' || Number(raw) <= 0) return []
      return [{ sourceLineId: line.sourceLineId, quantity: raw }]
    })
    if (lines.length === 0) {
      setInlineError(t('receive.noLines'))
      return
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(receiptDate)) {
      setInlineError(t('receive.invalidDate'))
      return
    }
    setInlineError(null)
    setSaving(true)
    try {
      const outcome = await onSubmit({ receiptDate, lines, idempotencyKey })
      if (!outcome.ok) setInlineError(outcome.message)
    } finally {
      setSaving(false)
    }
  }

  if (typeof document === 'undefined') return null
  return createPortal(
    <AnimatePresence>
      <div
        className="fixed inset-0 z-[60] flex items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        aria-label={t('receive.title')}
      >
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]"
          onClick={onClose}
          aria-hidden="true"
        />
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 8 }}
          transition={{ type: 'spring', damping: 26, stiffness: 340, mass: 0.7 }}
          className="relative max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900"
        >
          <div className="space-y-4 p-6">
            <h2 className="text-lg font-semibold">{t('receive.title')}</h2>
            {prefill === null && !prefillFailed ? (
              <p>{tCommon('actions.loading')}</p>
            ) : prefillFailed || prefill === null ? (
              <div className="space-y-3">
                <p role="alert">{t('receive.prefillFailed')}</p>
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" onClick={onClose}>{tCommon('actions.cancel')}</Button>
                  <Button onClick={() => setReloadNonce((n) => n + 1)}>{t('saveFailedRetry')}</Button>
                </div>
              </div>
            ) : prefill.lines.length === 0 ? (
              <div className="space-y-3">
                <p>{t('receive.noLines')}</p>
                <div className="flex justify-end">
                  <Button variant="secondary" onClick={onClose}>{tCommon('actions.close')}</Button>
                </div>
              </div>
            ) : (
              <>
                <div>
                  <FieldLabel htmlFor="receipt-date">{t('receive.receiptDate')}</FieldLabel>
                  <Input
                    id="receipt-date"
                    type="date"
                    value={receiptDate}
                    disabled={saving}
                    onChange={(e) => setReceiptDate(e.target.value)}
                  />
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left">
                      <th className="py-1 pr-2 font-medium">{t('columns.item')}</th>
                      <th className="py-1 pr-2 font-medium">{t('assignWarehouseLabel')}</th>
                      <th className="py-1 pr-2 font-medium">{t('receive.receiveQty')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {prefill.lines.map((line) => (
                      <tr key={line.sourceLineId} className="border-t border-slate-200 dark:border-slate-800">
                        <td className="py-2 pr-2">
                          <div>{line.description ?? line.sourceLineId}</div>
                          <div className="text-xs text-slate-500">
                            {t('receive.remaining', { remaining: `${line.remaining}${line.unit ? ` ${line.unit}` : ''}` })}
                          </div>
                        </td>
                        <td className="py-2 pr-2">{warehouseById.get(line.stockLocationId ?? '') ?? '—'}</td>
                        <td className="py-2">
                          <Input
                            aria-label={`${t('receive.receiveQty')} ${line.lineNumber}`}
                            type="number"
                            min="0"
                            step="any"
                            value={quantities[line.sourceLineId] ?? ''}
                            disabled={saving}
                            onChange={(e) =>
                              setQuantities((current) => ({ ...current, [line.sourceLineId]: e.target.value }))
                            }
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {inlineError ? <p role="alert">{inlineError}</p> : null}
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" disabled={saving} onClick={onClose}>{tCommon('actions.cancel')}</Button>
                  <Button disabled={saving} onClick={() => void save()}>
                    {saving ? tCommon('actions.saving') : tCommon('actions.save')}
                  </Button>
                </div>
              </>
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>,
    document.body,
  )
}
