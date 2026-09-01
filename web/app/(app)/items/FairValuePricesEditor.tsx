'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button, Card, CardContent, Input, Label } from '@openbooks/ui'

interface Price {
  id: string
  currency: string
  unit_price: string
  low_value: string | null
  high_value: string | null
  effective_from: string | null
  effective_to: string | null
  is_active: boolean
}
type FormState = { id: string | null; currency: string; unitPrice: string; lowValue: string; highValue: string; effectiveFrom: string; effectiveTo: string; isActive: boolean }

const field = 'space-y-1.5'
// PostgreSQL numeric values arrive as decimal strings. Keep them as strings so
// editing and saving never crosses JavaScript's lossy binary floating-point
// boundary (especially for values beyond Number.MAX_SAFE_INTEGER).
const num = (v: string | null) => (v != null ? String(v) : '')

/**
 * Fair-value / standalone selling prices for one item (fair_value_prices),
 * re-homed from Setup onto the item record — the dated, multi-currency form of
 * the single SSP field above. Manages its own dated rows via
 * /api/items/[id]/fair-values.
 */
export function FairValuePricesEditor({ itemId, canManage }: { itemId: string; canManage: boolean }) {
  const t = useTranslations('items.fairValue')
  const common = useTranslations('common')
  const [prices, setPrices] = useState<Price[]>([])
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState<FormState | null>(null)
  useEffect(() => {
    if (!canManage) setForm(null)
  }, [canManage])

  async function load() {
    const res = await fetch(`/api/items/${itemId}/fair-values`)
    if (!res.ok) return
    const data = (await res.json()) as { prices: Price[] }
    setPrices(data.prices)
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId])

  function startNew() {
    setForm({ id: null, currency: '', unitPrice: '', lowValue: '', highValue: '', effectiveFrom: '', effectiveTo: '', isActive: true })
  }
  function startEdit(p: Price) {
    setForm({
      id: p.id, currency: p.currency, unitPrice: num(p.unit_price), lowValue: num(p.low_value), highValue: num(p.high_value),
      effectiveFrom: p.effective_from ? String(p.effective_from).slice(0, 10) : '',
      effectiveTo: p.effective_to ? String(p.effective_to).slice(0, 10) : '',
      isActive: p.is_active,
    })
  }

  async function save() {
    if (!form) return
    setBusy(true)
    const body: Record<string, unknown> = {
      currency: form.currency, unitPrice: form.unitPrice, lowValue: form.lowValue === '' ? null : form.lowValue, highValue: form.highValue === '' ? null : form.highValue,
      effectiveFrom: form.effectiveFrom || null, effectiveTo: form.effectiveTo || null, isActive: form.isActive,
    }
    if (form.id) body.id = form.id
    const res = await fetch(`/api/items/${itemId}/fair-values`, {
      method: form.id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) {
      toast.error(typeof data.error === 'string' ? data.error : common('feedback.saveFailed'))
      return
    }
    toast.success(common('feedback.saved'))
    setForm(null)
    await load()
  }

  async function remove(id: string) {
    if (!confirm(t('confirmDelete'))) return
    setBusy(true)
    const res = await fetch(`/api/items/${itemId}/fair-values?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
    setBusy(false)
    if (!res.ok) {
      toast.error(common('feedback.saveFailed'))
      return
    }
    toast.success(common('feedback.deleted'))
    await load()
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('description')}</p>
        </div>
        {canManage && !form ? (
          <Button variant="outline" size="sm" onClick={startNew}>{t('new')}</Button>
        ) : null}
      </div>

      {form ? (
        <Card>
          <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className={field}>
              <Label>{t('currency')}<span className="text-red-500"> *</span></Label>
              <Input value={form.currency} maxLength={3} className="uppercase" onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} placeholder="USD" />
            </div>
            <div className={field}>
              <Label>{t('unitPrice')}<span className="text-red-500"> *</span></Label>
              <Input inputMode="decimal" className="text-right tabular-nums" value={form.unitPrice} onChange={(e) => setForm({ ...form, unitPrice: e.target.value })} />
            </div>
            <div className={field}>
              <Label>{t('lowValue')}</Label>
              <Input inputMode="decimal" className="text-right tabular-nums" value={form.lowValue} onChange={(e) => setForm({ ...form, lowValue: e.target.value })} />
            </div>
            <div className={field}>
              <Label>{t('highValue')}</Label>
              <Input inputMode="decimal" className="text-right tabular-nums" value={form.highValue} onChange={(e) => setForm({ ...form, highValue: e.target.value })} />
            </div>
            <div className={field}>
              <Label>{t('effectiveFrom')}</Label>
              <Input type="date" value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} />
            </div>
            <div className={field}>
              <Label>{t('effectiveTo')}</Label>
              <Input type="date" value={form.effectiveTo} onChange={(e) => setForm({ ...form, effectiveTo: e.target.value })} />
            </div>
            <label className="flex items-center gap-2 self-end pb-2 text-sm">
              <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500" />
              {common('status.active')}
            </label>
            <div className="flex items-end gap-2">
              <Button disabled={busy} onClick={save}>{busy ? common('actions.saving') : common('actions.save')}</Button>
              <Button variant="outline" onClick={() => setForm(null)}>{common('actions.cancel')}</Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {prices.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-900 dark:text-slate-400">
              <tr>
                <th className="px-3 py-2 font-medium">{t('currency')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('unitPrice')}</th>
                <th className="px-3 py-2 font-medium">{t('effectiveFrom')}</th>
                <th className="px-3 py-2 font-medium">{t('effectiveTo')}</th>
                <th className="px-3 py-2 font-medium">{common('labels.status')}</th>
                {canManage ? <th className="px-3 py-2" /> : null}
              </tr>
            </thead>
            <tbody>
              {prices.map((p) => (
                <tr key={p.id} className="border-t border-slate-100 dark:border-slate-800/60">
                  <td className="px-3 py-2 font-mono">{p.currency}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(p.unit_price)}</td>
                  <td className="px-3 py-2 tabular-nums">{p.effective_from ? String(p.effective_from).slice(0, 10) : '—'}</td>
                  <td className="px-3 py-2 tabular-nums">{p.effective_to ? String(p.effective_to).slice(0, 10) : '—'}</td>
                  <td className="px-3 py-2">
                    <Badge variant={p.is_active ? 'success' : 'outline'}>
                      {p.is_active ? common('status.active') : common('status.inactive')}
                    </Badge>
                  </td>
                  {canManage ? (
                    <td className="px-3 py-2 text-right">
                      <button type="button" onClick={() => startEdit(p)} className="text-xs font-medium text-teal-700 hover:underline dark:text-teal-300">{common('actions.edit')}</button>
                      <button type="button" onClick={() => remove(p.id)} disabled={busy} className="ml-3 text-xs font-medium text-red-600 hover:underline dark:text-red-400">{common('actions.delete')}</button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : !form ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('empty')}</p>
      ) : null}
    </section>
  )
}
