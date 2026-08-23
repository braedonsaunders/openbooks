'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Pencil, Plus, SlidersHorizontal } from 'lucide-react'
import { Button, Select, cn } from '@openbooks/ui'
import type { ForecastCategory, ForecastCategoryMethod } from '../../../../lib/cash/core'
import { Panel } from './Panel'

export interface CatOption { id: string; name: string }
export interface AccountOption { id: string; number: string | null; name: string; type?: string }

/** Forecast method values. */
const METHOD_VALUES: ForecastCategoryMethod[] = [
  'gl_history_average',
  'vendor_payment_history',
  'credit_card_cycle',
  'manual_recurring',
  'formula_expression',
  'vendor_recurring_average',
  'bank_register_history',
]

const DAY_KEYS = ['', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const WEEK_KEYS = ['', '1stWeek', '2ndWeek', '3rdWeek', '4thWeek']

const FORMULA_VARS = '{AR_IN} {AP_OUT} {NET_FLOW} {CASH_START} {WEEK_NUM} {MONTH} {QUARTER} {YEAR} {DAY} {IS_WK1}…{IS_WK5} {IS_MONTH_START} {IS_MONTH_END} {IS_Q_START} {IS_Q_END} {IS_YEAR_END}'
const FORMULA_FUNCS = 'IF(cond,a,b) MAX MIN ABS CEIL FLOOR ROUND SQRT POW AVG'

const inputCls = 'h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200'
const numCls = `${inputCls} text-right tabular-nums`
const labelCls = 'mb-1 block text-[11px] font-medium text-slate-600 dark:text-slate-300'
const helpCls = 'mt-0.5 block text-[11px] leading-snug text-slate-400 dark:text-slate-500'

/** Multi-select with a search box on top. */
function MultiPick({
  options,
  selected,
  onChange,
  placeholder,
}: {
  options: { id: string; label: string }[]
  selected: string[]
  onChange: (ids: string[]) => void
  placeholder: string
}) {
  const [q, setQ] = useState('')
  const t = useTranslations('analytics.categoryManager')
  const visible = options.filter((o) => !q || o.label.toLowerCase().includes(q.toLowerCase()))
  // Selected entries sort to the top (stable behavior).
  const ordered = [...visible].sort((a, b) => Number(selected.includes(b.id)) - Number(selected.includes(a.id)))
  return (
    <div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} className={cn(inputCls, 'mb-1')} />
      <div className="max-h-36 overflow-y-auto rounded-md border border-slate-200 dark:border-slate-700">
        {ordered.slice(0, 200).map((o) => {
          const on = selected.includes(o.id)
          return (
            <button
              key={o.id}
              type="button"
              onClick={() => onChange(on ? selected.filter((x) => x !== o.id) : [...selected, o.id])}
              className={cn('flex w-full items-center gap-2 px-2 py-1 text-left text-xs', on ? 'bg-teal-50 text-teal-800 dark:bg-teal-950/40 dark:text-teal-200' : 'text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800/60')}
            >
              <input type="checkbox" readOnly checked={on} className="h-3 w-3 accent-teal-600" />
              <span className="truncate">{o.label}</span>
            </button>
          )
        })}
        {ordered.length === 0 ? <p className="px-2 py-2 text-xs text-slate-400">{t('picker.noMatches')}</p> : null}
      </div>
      {selected.length ? <span className={helpCls}>{t('picker.selectedCount', { count: selected.length })}</span> : null}
    </div>
  )
}

/**
 * Forecast-category manager: all seven calculation methods with
 * their per-method settings, expected-day/week placement, and edit-in-place.
 * Edits the whole list and PUTs it to /api/analytics/cashflow/categories,
 * then refreshes so every forecast (analytics + cockpits) recomputes.
 */
export function CategoryManager({
  vendorOptions,
  accountOptions,
  initialCategories = [],
}: {
  vendorOptions: CatOption[]
  accountOptions: AccountOption[]
  initialCategories?: ForecastCategory[]
}) {
  const router = useRouter()
  const t = useTranslations('analytics.categoryManager')
  const tForm = useTranslations('analytics.categoryManager.form')
  const tMethods = useTranslations('analytics.categoryManager.methods')
  const [cats, setCats] = useState<ForecastCategory[]>(initialCategories)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  /** Index being edited, -1 for a new category, null = closed. */
  const [editIdx, setEditIdx] = useState<number | null>(null)
  const [draft, setDraft] = useState<ForecastCategory | null>(null)

  // Authoritative list of raw configs (payloads carry computed rows).
  useEffect(() => {
    fetch('/api/analytics/cashflow/categories')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j && Array.isArray(j.categories)) setCats(j.categories) })
      .catch(() => {})
  }, [])

  const glAccounts = accountOptions.filter((a) => !a.type || !['asset_bank', 'liability_card'].includes(a.type))
  const cardAccounts = accountOptions.filter((a) => a.type === 'liability_card')
  const bankAccounts = accountOptions.filter((a) => a.type === 'asset_bank')
  const acctLabel = (a: AccountOption) => (a.number ? `${a.number} · ${a.name}` : a.name)

  const save = async (next: ForecastCategory[]) => {
    setBusy(true)
    setMsg(null)
    const r = await fetch('/api/analytics/cashflow/categories', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categories: next }),
    })
    if (r.ok) {
      const j = await r.json()
      setCats(j.categories)
      setMsg(t('toasts.savedRecomputing'))
      setEditIdx(null)
      setDraft(null)
      router.refresh()
    } else {
      setMsg(r.status === 403 ? t('toasts.forbidden') : t('toasts.saveFailed', { status: r.status }))
    }
    setBusy(false)
  }

  const openEditor = (idx: number) => {
    setEditIdx(idx)
    setDraft(idx === -1
      ? { id: '', name: '', direction: 'outflow', method: 'gl_history_average' }
      : { ...cats[idx]! })
    setMsg(null)
  }

  const set = (patch: Partial<ForecastCategory>) => setDraft((d) => (d ? { ...d, ...patch } : d))

  const applyDraft = () => {
    if (!draft || !draft.name.trim()) return
    const clean: ForecastCategory = { ...draft, name: draft.name.trim() }
    if (draft.method === 'vendor_payment_history' || draft.method === 'vendor_recurring_average') {
      clean.partyName = vendorOptions.find((v) => v.id === (clean.partyIds?.[0] ?? clean.partyId))?.name
    }
    void save(editIdx === -1 ? [...cats, clean] : cats.map((c, i) => (i === editIdx ? clean : c)))
  }

  const method = draft ? { value: draft.method, description: tMethods.has(`${draft.method}.description`) ? tMethods(`${draft.method}.description`) : '' } : undefined
  const methodLabel = (value: string) => (tMethods.has(`${value}.label`) ? tMethods(`${value}.label`) : value)
  const dayOptions = DAY_KEYS.map((key, idx) => ({ value: String(idx - 1), label: key === '' ? t('days.distributed') : t(`days.${key}`) }))
  const weekOptions = WEEK_KEYS.map((key, idx) => ({ value: idx === 0 ? '' : String(idx), label: key === '' ? t('weeks.distributed') : t(`weeks.${key}`) }))
  const draftValid = !!draft && !!draft.name.trim() && (
    draft.method === 'manual_recurring' ? (draft.amount ?? 0) > 0
    : draft.method === 'gl_history_average' ? (draft.accountIds?.length ?? 0) > 0
    : draft.method === 'credit_card_cycle' ? (draft.cardAccountIds?.length ?? 0) > 0
    : draft.method === 'formula_expression' ? !!draft.formula?.trim()
    : draft.method === 'bank_register_history' ? (draft.bankAccountIds?.length ?? 0) > 0
    : (draft.partyIds?.length ?? 0) > 0 || !!draft.partyId
  )

  return (
    <Panel
      title={t('panelTitle')}
      icon={SlidersHorizontal}
      hint={t('panelHint')}
      actions={editIdx === null ? (
        <Button variant="outline" size="sm" onClick={() => openEditor(-1)}>
          <Plus size={14} />
          {t('newCategory')}
        </Button>
      ) : undefined}
    >
      {cats.length ? (
        <ul className="mb-4 divide-y divide-slate-50 dark:divide-slate-800/60">
          {cats.map((c, i) => (
            <li key={c.id || i} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="min-w-0">
                <span className={cn('mr-2 inline-block h-2 w-2 rounded-full', c.direction === 'inflow' ? 'bg-emerald-500' : 'bg-red-500')} />
                <span className="font-medium text-slate-800 dark:text-slate-200">{c.name}</span>
                <span className="ml-2 text-xs text-slate-400 dark:text-slate-500">
                  {methodLabel(c.method)}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <button type="button" disabled={busy} onClick={() => openEditor(i)} title={t('editTitle')} className="rounded-md border border-slate-200 p-1 text-slate-500 hover:text-teal-600 dark:border-slate-700 dark:hover:text-teal-400"><Pencil size={12} /></button>
                <button type="button" disabled={busy} onClick={() => save(cats.filter((_, j) => j !== i))} className="rounded-md border border-slate-200 px-2 py-0.5 text-[11px] text-slate-500 hover:text-rose-500 dark:border-slate-700">{t('remove')}</button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-4 text-xs text-slate-400 dark:text-slate-500">{t('empty')}</p>
      )}

      {editIdx !== null && draft ? (
        <div className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
          {/* General */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>{tForm('name')}</label>
              <input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder={tForm('namePlaceholder')} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>{tForm('type')}</label>
              <Select value={draft.direction} onChange={(e) => set({ direction: e.target.value as 'inflow' | 'outflow' })} triggerClassName="h-8 text-sm">
                <option value="outflow">{tForm('typeOutflow')}</option>
                <option value="inflow">{tForm('typeInflow')}</option>
              </Select>
            </div>
          </div>

          {/* Method */}
          <div>
            <label className={labelCls}>{tForm('calcMethod')}</label>
            <Select value={draft.method} onChange={(e) => set({ method: e.target.value as ForecastCategoryMethod })} triggerClassName="h-8 text-sm">
              {METHOD_VALUES.map((v) => <option key={v} value={v}>{methodLabel(v)}</option>)}
            </Select>
            {method ? <span className={helpCls}>{method.description}</span> : null}
          </div>

          {/* Method settings */}
          {draft.method === 'gl_history_average' ? (
            <>
              <div>
                <label className={labelCls}>{tForm('glAccounts')}</label>
                <MultiPick options={glAccounts.map((a) => ({ id: a.id, label: acctLabel(a) }))} selected={draft.accountIds ?? []} onChange={(accountIds) => set({ accountIds })} placeholder={tForm('searchAccounts')} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>{tForm('expectedDay')}</label>
                  <Select value={String(draft.expectedDay ?? '')} onChange={(e) => set({ expectedDay: e.target.value })} triggerClassName="h-8 text-sm">
                    {dayOptions.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                  </Select>
                </div>
                <div>
                  <label className={labelCls}>{tForm('expectedWeek')}</label>
                  <Select value={String(draft.expectedWeek ?? '')} onChange={(e) => set({ expectedWeek: e.target.value })} triggerClassName="h-8 text-sm">
                    {weekOptions.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
                  </Select>
                </div>
                <div>
                  <label className={labelCls}>{tForm('historyWeeks')}</label>
                  <input type="number" min={1} max={52} value={draft.historyWeeks ?? 12} onChange={(e) => set({ historyWeeks: Number(e.target.value) })} className={numCls} />
                </div>
                <div>
                  <label className={labelCls}>{tForm('adjustmentPct')}</label>
                  <input type="number" step={0.1} value={draft.adjustmentPct ?? 0} onChange={(e) => set({ adjustmentPct: Number(e.target.value) })} className={numCls} />
                </div>
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                <input type="checkbox" checked={draft.useNetAmt ?? false} onChange={(e) => set({ useNetAmt: e.target.checked })} className="h-4 w-4 accent-teal-600" />
                {tForm('useNetAmount')}
              </label>
            </>
          ) : draft.method === 'vendor_payment_history' || draft.method === 'vendor_recurring_average' ? (
            <>
              <div>
                <label className={labelCls}>{tForm('vendors')}</label>
                <MultiPick options={vendorOptions.map((v) => ({ id: v.id, label: v.name }))} selected={draft.partyIds ?? (draft.partyId ? [draft.partyId] : [])} onChange={(partyIds) => set({ partyIds, partyId: partyIds[0] })} placeholder={tForm('searchVendors')} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>{tForm('historyMonths')}</label>
                  <input type="number" min={1} max={36} value={draft.historyMonths ?? (draft.method === 'vendor_recurring_average' ? 3 : 12)} onChange={(e) => set({ historyMonths: Number(e.target.value) })} className={numCls} />
                </div>
                <div>
                  <label className={labelCls}>{tForm('adjustmentPct')}</label>
                  <input type="number" step={0.1} value={draft.adjustmentPct ?? 0} onChange={(e) => set({ adjustmentPct: Number(e.target.value) })} className={numCls} />
                </div>
                {draft.method === 'vendor_payment_history' ? (
                  <>
                    <div>
                      <label className={labelCls}>{tForm('expectedDay')}</label>
                      <Select value={String(draft.expectedDay ?? '')} onChange={(e) => set({ expectedDay: e.target.value })} triggerClassName="h-8 text-sm">
                        {dayOptions.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                      </Select>
                    </div>
                    <div>
                      <label className={labelCls}>{tForm('expectedWeek')}</label>
                      <Select value={String(draft.expectedWeek ?? '')} onChange={(e) => set({ expectedWeek: e.target.value })} triggerClassName="h-8 text-sm">
                        {weekOptions.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
                      </Select>
                    </div>
                  </>
                ) : null}
              </div>
            </>
          ) : draft.method === 'credit_card_cycle' ? (
            <>
              <div>
                <label className={labelCls}>{tForm('cardAccounts')}</label>
                <MultiPick options={(cardAccounts.length ? cardAccounts : accountOptions).map((a) => ({ id: a.id, label: acctLabel(a) }))} selected={draft.cardAccountIds ?? []} onChange={(cardAccountIds) => set({ cardAccountIds })} placeholder={tForm('searchCardAccounts')} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>{tForm('historyMonths')}</label>
                  <input type="number" min={1} max={24} value={draft.historyMonths ?? 6} onChange={(e) => set({ historyMonths: Number(e.target.value) })} className={numCls} />
                </div>
                <div>
                  <label className={labelCls}>{tForm('threshold')}</label>
                  <input type="number" min={0} value={draft.significantPaymentThreshold ?? 0} onChange={(e) => set({ significantPaymentThreshold: Number(e.target.value) })} className={numCls} />
                  <span className={helpCls}>{tForm('thresholdHelp')}</span>
                </div>
              </div>
            </>
          ) : draft.method === 'manual_recurring' ? (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>{tForm('amount')}</label>
                <input type="number" min={0} value={draft.amount ?? ''} onChange={(e) => set({ amount: Number(e.target.value) })} className={numCls} />
              </div>
              <div>
                <label className={labelCls}>{tForm('frequency')}</label>
                <Select value={draft.frequency ?? 'weekly'} onChange={(e) => set({ frequency: e.target.value as ForecastCategory['frequency'] })} triggerClassName="h-8 text-sm">
                  <option value="weekly">{tForm('frequencyWeekly')}</option>
                  <option value="biweekly">{tForm('frequencyBiweekly')}</option>
                  <option value="monthly">{tForm('frequencyMonthly')}</option>
                </Select>
              </div>
            </div>
          ) : draft.method === 'formula_expression' ? (
            <div>
              <label className={labelCls}>{tForm('formula')}</label>
              <textarea rows={4} value={draft.formula ?? ''} onChange={(e) => set({ formula: e.target.value })} placeholder="{AR_IN} * 0.02 + IF({IS_MONTH_END}, 5000, 0)" className={cn(inputCls, 'h-auto py-1.5 font-mono text-xs')} />
              <span className={helpCls}>{t('formulaHelp', { vars: FORMULA_VARS, funcs: FORMULA_FUNCS })}</span>
            </div>
          ) : draft.method === 'bank_register_history' ? (
            <>
              <div>
                <label className={labelCls}>{tForm('bankAccounts')}</label>
                <MultiPick options={bankAccounts.map((a) => ({ id: a.id, label: acctLabel(a) }))} selected={draft.bankAccountIds ?? []} onChange={(bankAccountIds) => set({ bankAccountIds })} placeholder={tForm('searchBankAccounts')} />
              </div>
              <div>
                <label className={labelCls}>{tForm('memoKeywords')}</label>
                <input value={(draft.memoKeywords ?? []).join(', ')} onChange={(e) => set({ memoKeywords: e.target.value.split(',').map((k) => k.trim()).filter(Boolean) })} placeholder={tForm('memoKeywordsPlaceholder')} className={inputCls} />
                <span className={helpCls}>{tForm('memoKeywordsHelp')}</span>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
                <label className="flex items-center gap-1.5"><input type="checkbox" checked={draft.includeTransfers !== false} onChange={(e) => set({ includeTransfers: e.target.checked })} className="h-4 w-4 accent-teal-600" /> {tForm('transfers')}</label>
                <label className="flex items-center gap-1.5"><input type="checkbox" checked={draft.includeChecks !== false} onChange={(e) => set({ includeChecks: e.target.checked })} className="h-4 w-4 accent-teal-600" /> {tForm('checksPayments')}</label>
                <label className="flex items-center gap-1.5"><input type="checkbox" checked={draft.includeJournals === true} onChange={(e) => set({ includeJournals: e.target.checked })} className="h-4 w-4 accent-teal-600" /> {tForm('journals')}</label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>{tForm('expectedDay')}</label>
                  <Select value={String(draft.expectedDay ?? '')} onChange={(e) => set({ expectedDay: e.target.value })} triggerClassName="h-8 text-sm">
                    {dayOptions.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                  </Select>
                </div>
                <div>
                  <label className={labelCls}>{tForm('historyWeeks')}</label>
                  <input type="number" min={1} max={52} value={draft.historyWeeks ?? 12} onChange={(e) => set({ historyWeeks: Number(e.target.value) })} className={numCls} />
                </div>
                <div>
                  <label className={labelCls}>{tForm('adjustmentPct')}</label>
                  <input type="number" step={0.1} value={draft.adjustmentPct ?? 0} onChange={(e) => set({ adjustmentPct: Number(e.target.value) })} className={numCls} />
                </div>
              </div>
            </>
          ) : null}

          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" disabled={busy || !draftValid} onClick={applyDraft}>
              {busy ? tForm('saving') : editIdx === -1 ? tForm('addCategory') : tForm('saveCategory')}
            </Button>
            <button type="button" onClick={() => { setEditIdx(null); setDraft(null) }} className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">{tForm('cancel')}</button>
            {msg ? <span className="text-xs text-slate-400 dark:text-slate-500">{msg}</span> : null}
          </div>
        </div>
      ) : msg ? (
        <span className="text-xs text-slate-400 dark:text-slate-500">{msg}</span>
      ) : null}
    </Panel>
  )
}
