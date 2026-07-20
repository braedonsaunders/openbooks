'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { SlidersHorizontal } from 'lucide-react'
import { Select, cn } from '@openbooks/ui'
import type { ForecastCategory } from '../../../../lib/cash/core'
import { Panel } from './Panel'

export interface CatOption { id: string; name: string }
export interface AccountOption { id: string; number: string | null; name: string }

/**
 * Forecast-category manager — Gantry's category config CRUD. Edits the full
 * list and PUTs it to /api/analytics/cashflow/categories, then refreshes so
 * every forecast (analytics + the cash cockpit) recomputes. Shared: takes the
 * vendor/account option lists as props rather than the whole dashboard payload.
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
  const [cats, setCats] = useState<ForecastCategory[]>(initialCategories)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [direction, setDirection] = useState<'inflow' | 'outflow'>('outflow')
  const [method, setMethod] = useState<ForecastCategory['method']>('manual_recurring')
  const [amount, setAmount] = useState('')
  const [frequency, setFrequency] = useState<'weekly' | 'biweekly' | 'monthly'>('monthly')
  const [partyId, setPartyId] = useState('')
  const [accountIds, setAccountIds] = useState<string[]>([])
  const [historyWeeks, setHistoryWeeks] = useState('12')
  const [adjustmentPct, setAdjustmentPct] = useState('0')

  // Authoritative list of raw configs (the payload carries computed rows).
  useEffect(() => {
    fetch('/api/analytics/cashflow/categories')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j && Array.isArray(j.categories)) setCats(j.categories) })
      .catch(() => {})
  }, [])

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
      setMsg('Saved — recomputing…')
      router.refresh()
    } else {
      setMsg(r.status === 403 ? 'Saving requires the Setup permission.' : `Save failed (${r.status}).`)
    }
    setBusy(false)
  }

  const add = () => {
    const draft: ForecastCategory = { id: '', name: name.trim(), direction, method }
    if (method === 'manual_recurring') { draft.amount = Number(amount); draft.frequency = frequency }
    else if (method === 'vendor_payment_history') { draft.partyId = partyId; draft.partyName = vendorOptions.find((v) => v.id === partyId)?.name }
    else { draft.accountIds = accountIds; draft.historyWeeks = Number(historyWeeks) || 12; draft.adjustmentPct = Number(adjustmentPct) || 0 }
    void save([...cats, draft])
    setName(''); setAmount(''); setPartyId(''); setAccountIds([])
  }
  const addDisabled = busy || !name.trim() ||
    (method === 'manual_recurring' && !(Number(amount) > 0)) ||
    (method === 'vendor_payment_history' && !partyId) ||
    (method === 'gl_history_average' && accountIds.length === 0)

  return (
    <Panel title="Forecast Categories" icon={SlidersHorizontal} hint="Non-AR/AP cash flows — rent, payroll, recurring subscriptions, GL-trend spend">
      {cats.length ? (
        <ul className="mb-4 divide-y divide-slate-50 dark:divide-slate-800/60">
          {cats.map((c, i) => (
            <li key={c.id || i} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="min-w-0">
                <span className={cn('mr-2 inline-block h-2 w-2 rounded-full', c.direction === 'inflow' ? 'bg-emerald-500' : 'bg-red-500')} />
                <span className="font-medium text-slate-800 dark:text-slate-200">{c.name}</span>
                <span className="ml-2 text-xs text-slate-400 dark:text-slate-500">
                  {c.method === 'manual_recurring' ? `$${Number(c.amount ?? 0).toLocaleString()} ${c.frequency ?? 'monthly'}` : c.method === 'vendor_payment_history' ? (c.partyName ?? 'vendor history') : `${c.accountIds?.length ?? 0} accounts · ${c.historyWeeks ?? 12}wk avg`}
                </span>
              </span>
              <button type="button" disabled={busy} onClick={() => save(cats.filter((_, j) => j !== i))} className="shrink-0 rounded-md border border-slate-200 px-2 py-0.5 text-[11px] text-slate-500 hover:text-rose-500 dark:border-slate-700">Remove</button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-4 text-xs text-slate-400 dark:text-slate-500">No categories yet — AR/AP predictions are the only flows in the forecast.</p>
      )}

      <div className="space-y-2 rounded-lg border border-slate-100 p-3 dark:border-slate-800">
        <div className="flex flex-wrap items-center gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Category name" className="h-7 w-40 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200" />
          <Select value={direction} onChange={(e) => setDirection(e.target.value as 'inflow' | 'outflow')} className="w-24" triggerClassName="h-7 text-xs">
            <option value="outflow">Outflow</option>
            <option value="inflow">Inflow</option>
          </Select>
          <Select value={method} onChange={(e) => setMethod(e.target.value as ForecastCategory['method'])} className="w-44" triggerClassName="h-7 text-xs">
            <option value="manual_recurring">Manual recurring</option>
            <option value="vendor_payment_history">Vendor payment history</option>
            <option value="gl_history_average">GL history average</option>
          </Select>
        </div>
        {method === 'manual_recurring' ? (
          <div className="flex flex-wrap items-center gap-2">
            <input value={amount} onChange={(e) => setAmount(e.target.value)} type="number" min={0} placeholder="Amount" className="h-7 w-28 rounded-md border border-slate-200 bg-white px-2 text-right text-xs tabular-nums text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200" />
            <Select value={frequency} onChange={(e) => setFrequency(e.target.value as typeof frequency)} className="w-28" triggerClassName="h-7 text-xs">
              <option value="weekly">Weekly</option>
              <option value="biweekly">Bi-weekly</option>
              <option value="monthly">Monthly</option>
            </Select>
          </div>
        ) : method === 'vendor_payment_history' ? (
          <Select value={partyId} onChange={(e) => setPartyId(e.target.value)} className="w-64" triggerClassName="h-7 text-xs">
            <option value="">Choose vendor…</option>
            {vendorOptions.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </Select>
        ) : (
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <Select value="" onChange={(e) => { const v = e.target.value; if (v && !accountIds.includes(v)) setAccountIds((a) => [...a, v]) }} className="w-64" triggerClassName="h-7 text-xs">
                <option value="">Add account…</option>
                {accountOptions.map((a) => (
                  <option key={a.id} value={a.id}>{a.number ? `${a.number} · ` : ''}{a.name}</option>
                ))}
              </Select>
              <input value={historyWeeks} onChange={(e) => setHistoryWeeks(e.target.value)} type="number" min={1} max={52} title="History weeks" className="h-7 w-16 rounded-md border border-slate-200 bg-white px-2 text-right text-xs tabular-nums text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200" />
              <span className="text-[11px] text-slate-400">wk history</span>
              <input value={adjustmentPct} onChange={(e) => setAdjustmentPct(e.target.value)} type="number" min={-90} max={200} title="Adjustment %" className="h-7 w-16 rounded-md border border-slate-200 bg-white px-2 text-right text-xs tabular-nums text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200" />
              <span className="text-[11px] text-slate-400">% adj</span>
            </div>
            {accountIds.length ? (
              <div className="flex flex-wrap gap-1">
                {accountIds.map((id) => {
                  const a = accountOptions.find((x) => x.id === id)
                  return (
                    <button key={id} type="button" onClick={() => setAccountIds((prev) => prev.filter((x) => x !== id))} title="Remove" className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600 hover:text-rose-500 dark:bg-slate-800 dark:text-slate-300">
                      {a ? (a.number ? `${a.number}` : a.name.slice(0, 18)) : id.slice(0, 6)} ×
                    </button>
                  )
                })}
              </div>
            ) : null}
          </div>
        )}
        <div className="flex items-center gap-2">
          <button type="button" disabled={addDisabled} onClick={add} className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40 hover:bg-teal-700">Add category</button>
          {msg ? <span className="text-xs text-slate-400 dark:text-slate-500">{msg}</span> : null}
        </div>
        <p className="text-[11px] leading-snug text-slate-400 dark:text-slate-500">
          Categories forecast recurring cash flows outside the AR/AP pipeline — from GL history, vendor payment cadence, or a fixed recurring schedule.
        </p>
      </div>
    </Panel>
  )
}
