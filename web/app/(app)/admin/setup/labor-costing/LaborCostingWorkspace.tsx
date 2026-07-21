'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Plus, Trash2 } from 'lucide-react'
import { Button, Input, Label, cn } from '@openbooks/ui'
import type { LaborCostComponent, LaborCostingSettings } from '@openbooks/engine/src/labor-costing.ts'

export interface RateRow {
  id: string
  employee_party_id: string | null
  trade_id: string | null
  rate: string
  basis: string
  annual_hours: string
  effective_from: string
  effective_to: string | null
  notes: string | null
  employee_name: string | null
  trade_name: string | null
}

interface Opt {
  id: string
  name: string
}

const today = () => new Date().toISOString().slice(0, 10)

/** Mirror of engine computeCostRate for the live preview (display only). */
function previewRate(wage: number, mult: number, s: { hoursPerDay: number; components: LaborCostComponent[] }): number {
  let rate = wage * mult
  for (const c of s.components) {
    const v = Number(c.value)
    if (!Number.isFinite(v) || v === 0) continue
    if (c.kind === 'percent_of_wage') rate += (c.scaleWithOvertime ? wage * mult : wage) * (v / 100)
    else if (c.kind === 'per_hour') rate += c.scaleWithOvertime ? v * mult : v
    else if (c.kind === 'per_day') rate += s.hoursPerDay > 0 ? v / s.hoursPerDay : 0
  }
  return rate
}

const selectCls =
  'h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100'

function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
      {hint && <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  )
}

export function LaborCostingWorkspace(props: {
  settings: LaborCostingSettings
  rates: RateRow[]
  employees: Opt[]
  trades: Opt[]
  accounts: { id: string; label: string }[]
  laborWip: string | null
  laborClearing: string | null
  payrollVariance: string | null
}) {
  const t = useTranslations('admin.setup.laborCosting')
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  // ---- settings state ------------------------------------------------------
  const [mode, setMode] = useState(props.settings.mode)
  const [hoursPerDay, setHoursPerDay] = useState(String(props.settings.hoursPerDay))
  const [annualHours, setAnnualHours] = useState(String(props.settings.annualHours))
  const [components, setComponents] = useState<LaborCostComponent[]>(props.settings.components)
  const [laborWip, setLaborWip] = useState(props.laborWip ?? '')
  const [laborClearing, setLaborClearing] = useState(props.laborClearing ?? '')
  const [payrollVariance, setPayrollVariance] = useState(props.payrollVariance ?? '')

  // ---- reconciliation state ------------------------------------------------
  const now = new Date()
  const lastMonth = new Date(Date.UTC(now.getFullYear(), now.getMonth() - 1, 1))
  const lastMonthEnd = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 0))
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const [recFrom, setRecFrom] = useState(iso(lastMonth))
  const [recTo, setRecTo] = useState(iso(lastMonthEnd))
  const [rec, setRec] = useState<{
    standardPosted: string
    payrollPosted: string
    periodVariance: string
    openBalance: string
    perProject: { projectId: string; name: string; standard: string }[]
  } | null>(null)

  // ---- new-rate form -------------------------------------------------------
  const [scope, setScope] = useState<'employee' | 'trade' | 'org'>('employee')
  const [scopeId, setScopeId] = useState('')
  const [rate, setRate] = useState('')
  const [basis, setBasis] = useState<'hour' | 'year'>('hour')
  const [from, setFrom] = useState(today())

  const exampleWage = useMemo(() => {
    const current = props.rates.find((r) => r.employee_party_id && !r.effective_to)
    return current ? Number(current.rate) : 40
  }, [props.rates])
  const live = { hoursPerDay: Number(hoursPerDay) || 8, components }

  async function saveSettings() {
    setBusy(true)
    try {
      const res = await fetch('/api/admin/setup/labor-costing', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settings: { mode, hoursPerDay: Number(hoursPerDay), annualHours: Number(annualHours), components },
          laborWip: laborWip || null,
          laborClearing: laborClearing || null,
          payrollVariance: payrollVariance || null,
        }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'failed')
      toast.success(t('saved'))
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function post(payload: Record<string, unknown>) {
    setBusy(true)
    try {
      const res = await fetch('/api/admin/setup/labor-costing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'failed')
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function addRate() {
    if (!rate || Number(rate) < 0) return toast.error(t('rateRequired'))
    if (scope !== 'org' && !scopeId) return toast.error(t('scopeRequired'))
    await post({
      action: 'save-rate',
      employeePartyId: scope === 'employee' ? scopeId : null,
      tradeId: scope === 'trade' ? scopeId : null,
      rate: Number(rate),
      basis,
      annualHours: Number(annualHours) || 2080,
      effectiveFrom: from,
    })
    setRate('')
    toast.success(t('rateSaved'))
  }

  async function loadReconciliation() {
    setBusy(true)
    try {
      const res = await fetch('/api/admin/setup/labor-costing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reconcile', periodStart: recFrom, periodEnd: recTo }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'failed')
      setRec(j)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function postVariance() {
    setBusy(true)
    try {
      const res = await fetch('/api/admin/setup/labor-costing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'post-variance', periodStart: recFrom, periodEnd: recTo }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'failed')
      toast.success(t('reconciliation.variancePosted', { amount: Number(j.variance).toFixed(2) }))
      await loadReconciliation()
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function setComponent(i: number, patch: Partial<LaborCostComponent>) {
    setComponents((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)))
  }

  const scopeLabel = (r: RateRow) =>
    r.employee_name ?? (r.trade_name ? `${t('tradePrefix')} ${r.trade_name}` : t('orgDefault'))

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {/* ---- wage rates ---- */}
      <Card title={t('rates.title')} hint={t('rates.hint')}>
        <div className="mb-3 grid grid-cols-2 gap-2 lg:grid-cols-6">
          <select aria-label={t('rates.scope')} className={cn(selectCls)} value={scope} onChange={(e) => { setScope(e.target.value as typeof scope); setScopeId('') }}>
            <option value="employee">{t('rates.scopeEmployee')}</option>
            <option value="trade">{t('rates.scopeTrade')}</option>
            <option value="org">{t('rates.scopeOrg')}</option>
          </select>
          {scope !== 'org' ? (
            <select aria-label={t('rates.who')} className={cn(selectCls, 'lg:col-span-2')} value={scopeId} onChange={(e) => setScopeId(e.target.value)}>
              <option value="">—</option>
              {(scope === 'employee' ? props.employees : props.trades).map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          ) : (
            <div className="lg:col-span-2" />
          )}
          <Input aria-label={t('rates.rate')} type="number" min="0" step="0.01" placeholder={t('rates.rate')} value={rate} onChange={(e) => setRate(e.target.value)} />
          <select aria-label={t('rates.basis')} className={cn(selectCls)} value={basis} onChange={(e) => setBasis(e.target.value as typeof basis)}>
            <option value="hour">{t('rates.perHour')}</option>
            <option value="year">{t('rates.perYear')}</option>
          </select>
          <div className="flex gap-2">
            <Input aria-label={t('rates.from')} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <Button size="sm" onClick={addRate} disabled={busy} aria-label={t('rates.add')}>
              <Plus size={14} />
            </Button>
          </div>
        </div>
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 dark:text-slate-400">
                <th className="py-1 pr-2 font-medium">{t('rates.scope')}</th>
                <th className="py-1 pr-2 font-medium">{t('rates.rate')}</th>
                <th className="py-1 pr-2 font-medium">{t('rates.from')}</th>
                <th className="py-1 pr-2 font-medium">{t('rates.to')}</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {props.rates.length === 0 && (
                <tr><td colSpan={5} className="py-6 text-center text-sm text-slate-400">{t('rates.empty')}</td></tr>
              )}
              {props.rates.map((r) => (
                <tr key={r.id} className={cn('border-t border-slate-100 dark:border-slate-800', r.effective_to && 'text-slate-400 dark:text-slate-500')}>
                  <td className="py-1.5 pr-2">{scopeLabel(r)}</td>
                  <td className="py-1.5 pr-2 tabular-nums">
                    ${Number(r.rate).toFixed(2)}
                    <span className="text-xs text-slate-400"> /{r.basis === 'year' ? t('rates.yr') : t('rates.hr')}</span>
                  </td>
                  <td className="py-1.5 pr-2 tabular-nums">{r.effective_from}</td>
                  <td className="py-1.5 pr-2 tabular-nums">{r.effective_to ?? '—'}</td>
                  <td className="py-1.5 text-right">
                    <button
                      type="button"
                      aria-label={t('rates.delete')}
                      className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950"
                      onClick={() => post({ action: 'delete-rate', id: r.id })}
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* ---- estimate components ---- */}
      <Card title={t('components.title')} hint={t('components.hint')}>
        <div className="space-y-2">
          {components.map((c, i) => (
            <div key={i} className="grid grid-cols-12 items-center gap-2">
              <Input aria-label={t('components.name')} className="col-span-4" value={c.name} onChange={(e) => setComponent(i, { name: e.target.value })} />
              <select aria-label={t('components.kind')} className={cn(selectCls, 'col-span-3')} value={c.kind} onChange={(e) => setComponent(i, { kind: e.target.value as LaborCostComponent['kind'] })}>
                <option value="percent_of_wage">{t('components.percentOfWage')}</option>
                <option value="per_hour">{t('components.perHour')}</option>
                <option value="per_day">{t('components.perDay')}</option>
              </select>
              <Input aria-label={t('components.value')} className="col-span-2" type="number" min="0" step="0.01" value={String(c.value)} onChange={(e) => setComponent(i, { value: Number(e.target.value) })} />
              <label className="col-span-2 flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                <input type="checkbox" checked={c.scaleWithOvertime === true} onChange={(e) => setComponent(i, { scaleWithOvertime: e.target.checked })} disabled={c.kind === 'per_day'} />
                {t('components.scalesOt')}
              </label>
              <button type="button" aria-label={t('components.remove')} className="col-span-1 rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950" onClick={() => setComponents((cs) => cs.filter((_, j) => j !== i))}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setComponents((cs) => [...cs, { key: `c${cs.length}`, name: t('components.newBurden'), kind: 'percent_of_wage', value: 13, scaleWithOvertime: true }])}
            >
              <Plus size={14} /> {t('components.addBurden')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setComponents((cs) => [...cs, { key: `c${cs.length}`, name: t('components.newPerDiem'), kind: 'per_day', value: 0 }])}
            >
              <Plus size={14} /> {t('components.addPerDiem')}
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-3 pt-2">
            <div>
              <Label htmlFor="lc-hpd">{t('components.hoursPerDay')}</Label>
              <Input id="lc-hpd" type="number" min="1" max="24" value={hoursPerDay} onChange={(e) => setHoursPerDay(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="lc-ah">{t('components.annualHours')}</Label>
              <Input id="lc-ah" type="number" min="1" value={annualHours} onChange={(e) => setAnnualHours(e.target.value)} />
            </div>
          </div>
          {/* live example */}
          <div className="mt-2 rounded-md bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
            {t('components.example', { wage: exampleWage.toFixed(2) })}
            <div className="mt-1 flex gap-4 font-medium tabular-nums text-slate-900 dark:text-slate-100">
              <span>{t('components.exampleReg')}: ${previewRate(exampleWage, 1, live).toFixed(2)}/h</span>
              <span>{t('components.exampleOt')}: ${previewRate(exampleWage, 1.5, live).toFixed(2)}/h</span>
              <span>{t('components.exampleDt')}: ${previewRate(exampleWage, 2, live).toFixed(2)}/h</span>
            </div>
          </div>
        </div>
      </Card>

      {/* ---- posting ---- */}
      <Card title={t('posting.title')} hint={t('posting.hint')}>
        <div className="space-y-3">
          <div className="flex gap-2">
            {(['off', 'post'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={cn(
                  'rounded-md border px-3 py-1.5 text-sm',
                  mode === m
                    ? 'border-teal-600 bg-teal-50 font-medium text-teal-700 dark:border-teal-400 dark:bg-teal-950/50 dark:text-teal-300'
                    : 'border-slate-300 text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800',
                )}
              >
                {m === 'off' ? t('posting.modeOff') : t('posting.modePost')}
              </button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="lc-wip">{t('posting.laborWip')}</Label>
              <select id="lc-wip" className={cn(selectCls)} value={laborWip} onChange={(e) => setLaborWip(e.target.value)}>
                <option value="">—</option>
                {props.accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.label}</option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="lc-clr">{t('posting.laborClearing')}</Label>
              <select id="lc-clr" className={cn(selectCls)} value={laborClearing} onChange={(e) => setLaborClearing(e.target.value)}>
                <option value="">—</option>
                {props.accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.label}</option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="lc-var">{t('posting.payrollVariance')}</Label>
              <select id="lc-var" className={cn(selectCls)} value={payrollVariance} onChange={(e) => setPayrollVariance(e.target.value)}>
                <option value="">—</option>
                {props.accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.label}</option>
                ))}
              </select>
            </div>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('posting.overheadNote')}</p>
        </div>
      </Card>

      {/* ---- payroll reconciliation ---- */}
      <Card title={t('reconciliation.title')} hint={t('reconciliation.hint')}>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label htmlFor="rec-from">{t('reconciliation.from')}</Label>
            <Input id="rec-from" type="date" value={recFrom} onChange={(e) => setRecFrom(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="rec-to">{t('reconciliation.to')}</Label>
            <Input id="rec-to" type="date" value={recTo} onChange={(e) => setRecTo(e.target.value)} />
          </div>
          <Button size="sm" variant="outline" onClick={loadReconciliation} disabled={busy}>{t('reconciliation.load')}</Button>
          {rec && Number(rec.periodVariance) !== 0 && (
            <Button size="sm" onClick={postVariance} disabled={busy || !props.payrollVariance}>
              {t('reconciliation.postVariance')}
            </Button>
          )}
        </div>
        {rec && (
          <div className="mt-3 space-y-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                { k: 'standardPosted', v: rec.standardPosted },
                { k: 'payrollPosted', v: rec.payrollPosted },
                { k: 'periodVariance', v: rec.periodVariance },
                { k: 'openBalance', v: rec.openBalance },
              ].map(({ k, v }) => (
                <div key={k} className="rounded-md bg-slate-50 p-2.5 dark:bg-slate-800/60">
                  <div className="text-xs text-slate-500 dark:text-slate-400">{t(`reconciliation.${k}`)}</div>
                  <div className={cn('text-sm font-semibold tabular-nums', k !== 'standardPosted' && k !== 'payrollPosted' && Number(v) !== 0 ? 'text-amber-600 dark:text-amber-400' : 'text-slate-900 dark:text-slate-100')}>
                    ${Number(v).toFixed(2)}
                  </div>
                </div>
              ))}
            </div>
            {rec.perProject.length > 0 && (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 dark:text-slate-400">
                    <th className="py-1 pr-2 font-medium">{t('reconciliation.project')}</th>
                    <th className="py-1 pr-2 text-right font-medium">{t('reconciliation.standardCost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rec.perProject.map((r) => (
                    <tr key={r.projectId} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="py-1.5 pr-2">{r.name}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">${Number(r.standard).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </Card>

      <div className="xl:col-span-2">
        <Button onClick={saveSettings} disabled={busy}>{t('save')}</Button>
      </div>
    </div>
  )
}
