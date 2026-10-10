'use client'

import { Table as SharedTable, TableHeader as SharedTableHeader, TableRow as SharedTableRow, TableHead as SharedTableHead, TableBody as SharedTableBody, TableCell as SharedTableCell } from "@openbooks/ui"
import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { fetchAction } from '@braedonsaunders/appkit-errors'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import { Badge, Button, Drawer, Input, Label, Select } from '@openbooks/ui'
import { DrawerSublist, SublistAddButton, SublistEmpty, SublistLoadError, SublistLoading } from '@/components/drawer-sublist'
import { useAppAction } from '../../../lib/use-app-action'
import { confirmDialog } from '@/lib/confirm'
import { apiJson, ApiResponseError } from '@/lib/api-error'

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
 * /api/items/[id]/fair-values; the currency is picked from the
 * organization's enabled currencies that read returns, never typed.
 */
export function FairValuePricesEditor({ itemId, canManage }: { itemId: string; canManage: boolean }) {
  const t = useTranslations('items.fairValue')
  const common = useTranslations('common')
  const [prices, setPrices] = useState<Price[]>([])
  const [currencies, setCurrencies] = useState<Array<{ value: string; label: string }>>([])
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'failed'>('loading')
  const [loadError, setLoadError] = useState('')
  const action = useAppAction()
  const busy = action.busy
  const [form, setForm] = useState<FormState | null>(null)
  // A read-only viewer must never hold the form open. Adjusted during render
  // (same committed value, no extra render).
  if (!canManage && form !== null) setForm(null)

  // Fetch chain: every state update sits in a promise continuation (the fetch
  // response), never synchronously in the effect body.
  function load() {
    setLoadState('loading')
    setLoadError('')
    setPrices([])
    return apiJson<{ prices: Price[]; currencies?: Array<{ value: string; label: string }> }>(`/api/items/${itemId}/fair-values`, undefined, common('feedback.loadFailed'))
      .then((data) => {
        if (!Array.isArray(data.prices)) throw new Error(common('feedback.loadFailed'))
        setPrices(data.prices)
        setCurrencies(Array.isArray(data.currencies) ? data.currencies : [])
        setLoadState('loaded')
      })
      .catch((error: unknown) => {
        setLoadError(error instanceof ApiResponseError ? error.message : common('feedback.loadFailed'))
        setLoadState('failed')
      })
  }
  useEffect(() => {
    void Promise.resolve().then(load)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId])

  function startNew() {
    if (loadState !== 'loaded') return
    setForm({ id: null, currency: currencies.length === 1 ? currencies[0]!.value : '', unitPrice: '', lowValue: '', highValue: '', effectiveFrom: '', effectiveTo: '', isActive: true })
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
    const body: Record<string, unknown> = {
      currency: form.currency, unitPrice: form.unitPrice, lowValue: form.lowValue === '' ? null : form.lowValue, highValue: form.highValue === '' ? null : form.highValue,
      effectiveFrom: form.effectiveFrom || null, effectiveTo: form.effectiveTo || null, isActive: form.isActive,
    }
    if (form.id) body.id = form.id
    await action.execute(() => fetchAction(`/api/items/${itemId}/fair-values`, {
      method: form.id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }), {
      fallbackMessage: common('feedback.saveFailed'),
      successMessage: common('feedback.saved'),
      onOk: () => { setForm(null); void load() },
    })
  }

  async function remove(id: string) {
    if (!(await confirmDialog(t('confirmDelete')))) return
    await action.execute(() => fetchAction(`/api/items/${itemId}/fair-values?id=${encodeURIComponent(id)}`, { method: 'DELETE' }), {
      fallbackMessage: common('feedback.saveFailed'),
      successMessage: common('feedback.deleted'),
      onOk: () => { void load() },
    })
  }

  // A stored row keeps its currency selectable even when the organization no
  // longer enables it, so editing never silently changes it.
  const currencyChoices = form?.currency && !currencies.some((option) => option.value === form.currency)
    ? [{ value: form.currency, label: form.currency }, ...currencies]
    : currencies

  return (
    <DrawerSublist
      title={t('title')}
      description={t('description')}
      action={canManage && loadState === 'loaded' ? <SublistAddButton label={t('new')} onClick={startNew} /> : undefined}
      alert={form ? null : <ActionAlert error={action.refusal} fallbackMessage={common('feedback.saveFailed')} />}
    >
      {loadState === 'loading' ? <SublistLoading /> : null}
      {loadState === 'failed' ? <SublistLoadError message={loadError} onRetry={() => { void load() }} /> : null}
      {loadState === 'loaded' && prices.length === 0 ? <SublistEmpty text={t('empty')} /> : null}
      {prices.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
          <SharedTable className="w-full text-sm">
            <SharedTableHeader className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-900 dark:text-slate-400">
              <SharedTableRow>
                <SharedTableHead className="px-3 py-2 font-medium">{t('currency')}</SharedTableHead>
                <SharedTableHead className="px-3 py-2 text-right font-medium">{t('unitPrice')}</SharedTableHead>
                <SharedTableHead className="px-3 py-2 font-medium">{t('effectiveFrom')}</SharedTableHead>
                <SharedTableHead className="px-3 py-2 font-medium">{t('effectiveTo')}</SharedTableHead>
                <SharedTableHead className="px-3 py-2 font-medium">{common('labels.status')}</SharedTableHead>
                {canManage ? <SharedTableHead className="px-3 py-2" /> : null}
              </SharedTableRow>
            </SharedTableHeader>
            <SharedTableBody>
              {prices.map((p) => (
                <SharedTableRow key={p.id} className="border-t border-slate-100 dark:border-slate-800/60">
                  <SharedTableCell className="px-3 py-2 font-mono">{p.currency}</SharedTableCell>
                  <SharedTableCell className="px-3 py-2 text-right tabular-nums">{num(p.unit_price)}</SharedTableCell>
                  <SharedTableCell className="px-3 py-2 tabular-nums">{p.effective_from ? String(p.effective_from).slice(0, 10) : '—'}</SharedTableCell>
                  <SharedTableCell className="px-3 py-2 tabular-nums">{p.effective_to ? String(p.effective_to).slice(0, 10) : '—'}</SharedTableCell>
                  <SharedTableCell className="px-3 py-2">
                    <Badge variant={p.is_active ? 'success' : 'outline'}>
                      {p.is_active ? common('status.active') : common('status.inactive')}
                    </Badge>
                  </SharedTableCell>
                  {canManage ? (
                    <SharedTableCell className="px-3 py-2 text-right">
                      <button type="button" onClick={() => startEdit(p)} className="text-xs font-medium text-teal-700 hover:underline dark:text-teal-300">{common('actions.edit')}</button>
                      <button type="button" onClick={() => remove(p.id)} disabled={busy} className="ml-3 text-xs font-medium text-red-600 hover:underline dark:text-red-400">{common('actions.delete')}</button>
                    </SharedTableCell>
                  ) : null}
                </SharedTableRow>
              ))}
            </SharedTableBody>
          </SharedTable>
        </div>
      ) : null}

      <Drawer
        open={form !== null}
        onClose={() => { if (!busy) setForm(null) }}
        stacked
        size="md"
        title={form?.id ? t('edit') : t('new')}
        footer={(
          <>
            <Button variant="outline" disabled={busy} onClick={() => setForm(null)}>{common('actions.cancel')}</Button>
            <Button disabled={busy || !form?.currency || !form?.unitPrice} onClick={save}>{busy ? common('actions.saving') : common('actions.save')}</Button>
          </>
        )}
      >
        {form ? (
          <div className="space-y-4">
            <ActionAlert error={action.refusal} fallbackMessage={common('feedback.saveFailed')} />
            <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
            <div className={field}>
              <Label>{t('currency')}<span className="text-red-500"> *</span></Label>
              <Select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} aria-label={t('currency')}>
                <option value="">{t('selectCurrency')}</option>
                {currencyChoices.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </Select>
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
            <label className="flex items-center gap-2 self-end pb-2 text-sm sm:col-span-2">
              <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500" />
              {common('status.active')}
            </label>
            </fieldset>
          </div>
        ) : null}
      </Drawer>
    </DrawerSublist>
  )
}
