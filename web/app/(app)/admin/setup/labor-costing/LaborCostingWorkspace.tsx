'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ArrowRight, Plus, Sparkles, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { Button, Input, Label, Select, cn } from '@openbooks/ui'
import { PagedTable } from '../../../../../components/paged-table'
import type { LaborCostComponent, LaborCostingSettings } from '@openbooks/engine/src/labor-costing.ts'
import { LaborCostingWizard } from './LaborCostingWizard'

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
  coverage: { employees: number; covered: number; hasOrgDefault: boolean }
}) {
  const t = useTranslations('admin.setup.laborCosting')
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [wizardOpen, setWizardOpen] = useState(props.rates.length === 0)

  // ---- settings state ------------------------------------------------------
  const [mode, setMode] = useState(props.settings.mode)
  const [hoursPerDay, setHoursPerDay] = useState(String(props.settings.hoursPerDay))
  const [annualHours, setAnnualHours] = useState(String(props.settings.annualHours))
  const [components, setComponents] = useState<LaborCostComponent[]>(props.settings.components)
  const [laborWip, setLaborWip] = useState(props.laborWip ?? '')
  const [laborClearing, setLaborClearing] = useState(props.laborClearing ?? '')
  const [payrollVariance, setPayrollVariance] = useState(props.payrollVariance ?? '')

  // Unsaved-changes tracking: everything the Save action persists, in one
  // stable snapshot. Rates save instantly and are not part of this.
  const makeSnap = (v: { mode: string; hoursPerDay: string; annualHours: string; components: LaborCostComponent[]; laborWip: string; laborClearing: string; payrollVariance: string }) =>
    JSON.stringify([v.mode, v.hoursPerDay, v.annualHours, v.components, v.laborWip, v.laborClearing, v.payrollVariance])
  const [savedSnap, setSavedSnap] = useState(() =>
    makeSnap({
      mode: props.settings.mode,
      hoursPerDay: String(props.settings.hoursPerDay),
      annualHours: String(props.settings.annualHours),
      components: props.settings.components,
      laborWip: props.laborWip ?? '',
      laborClearing: props.laborClearing ?? '',
      payrollVariance: props.payrollVariance ?? '',
    }))
  const currentSnap = makeSnap({ mode, hoursPerDay, annualHours, components, laborWip, laborClearing, payrollVariance })
  const dirty = currentSnap !== savedSnap

  // Rates list controls.
  const [showHistory, setShowHistory] = useState(false)

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
      setSavedSnap(currentSnap)
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function discardChanges() {
    setMode(props.settings.mode)
    setHoursPerDay(String(props.settings.hoursPerDay))
    setAnnualHours(String(props.settings.annualHours))
    setComponents(props.settings.components)
    setLaborWip(props.laborWip ?? '')
    setLaborClearing(props.laborClearing ?? '')
    setPayrollVariance(props.payrollVariance ?? '')
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

  const steps = [
    {
      key: 'wages',
      done: props.coverage.employees > 0 && props.coverage.covered === props.coverage.employees,
      detail: t('checklist.wagesDetail', { covered: props.coverage.covered, total: props.coverage.employees }),
    },
    {
      key: 'burden',
      done: components.length > 0,
      detail: components.length > 0 ? t('checklist.burdenDone', { count: components.length }) : t('checklist.burdenNone'),
    },
    {
      key: 'posting',
      done: mode === 'post' && !!laborWip && !!laborClearing,
      detail: mode === 'post' ? (laborWip && laborClearing ? t('checklist.postingOn') : t('checklist.postingAccounts')) : t('checklist.postingOff'),
    },
    {
      key: 'trueup',
      done: !!payrollVariance,
      detail: payrollVariance ? t('checklist.trueupReady') : t('checklist.trueupNone'),
    },
  ]

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <LaborCostingWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onApplied={(applied) => {
          const next = {
            mode: applied.mode,
            hoursPerDay,
            annualHours,
            components: applied.components,
            laborWip: applied.laborWip ?? laborWip,
            laborClearing: applied.laborClearing ?? laborClearing,
            payrollVariance: applied.payrollVariance ?? payrollVariance,
          }
          setMode(next.mode)
          setComponents(next.components)
          setLaborWip(next.laborWip)
          setLaborClearing(next.laborClearing)
          setPayrollVariance(next.payrollVariance)
          setSavedSnap(makeSnap(next))
        }}
        trades={props.trades}
        accounts={props.accounts}
        hoursPerDay={Number(hoursPerDay) || 8}
        annualHours={Number(annualHours) || 2080}
      />

      {/* ---- guided status ---- */}
      <div className="xl:col-span-2">
        <div className="flex flex-wrap items-stretch gap-3">
          {steps.map((st, i) => (
            <div key={st.key} className="min-w-48 flex-1 rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
              <div className="mb-1 flex items-center gap-2">
                <span
                  className={cn(
                    'grid h-5 w-5 place-items-center rounded-full text-[11px] font-semibold',
                    st.done
                      ? 'bg-teal-600 text-white dark:bg-teal-500 dark:text-slate-950'
                      : 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-200',
                  )}
                >
                  {st.done ? '✓' : i + 1}
                </span>
                <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t(`checklist.${st.key}`)}</span>
              </div>
              <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">{st.detail}</p>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setWizardOpen(true)}
            className="flex min-w-40 items-center justify-center gap-2 rounded-lg border border-dashed border-teal-400 px-4 text-sm font-medium text-teal-700 hover:bg-teal-50 dark:border-teal-600 dark:text-teal-300 dark:hover:bg-teal-950/40"
          >
            <Sparkles size={15} /> {t('checklist.launchWizard')}
          </button>
        </div>
      </div>

      {/* ---- wage rates ---- */}
      <Card title={t('rates.title')} hint={t('rates.hint')}>
        <div className="mb-3 grid grid-cols-2 gap-2 lg:grid-cols-6">
          <Select aria-label={t('rates.scope')} value={scope} onChange={(e) => { setScope(e.target.value as typeof scope); setScopeId('') }}>
            <option value="employee">{t('rates.scopeEmployee')}</option>
            <option value="trade">{t('rates.scopeTrade')}</option>
            <option value="org">{t('rates.scopeOrg')}</option>
          </Select>
          {scope !== 'org' ? (
            <Select aria-label={t('rates.who')} className="lg:col-span-2" value={scopeId} onChange={(e) => setScopeId(e.target.value)}>
              <option value="">—</option>
              {(scope === 'employee' ? props.employees : props.trades).map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </Select>
          ) : (
            <div className="lg:col-span-2" />
          )}
          <Input aria-label={t('rates.rate')} type="number" min="0" step="0.01" placeholder={t('rates.rate')} value={rate} onChange={(e) => setRate(e.target.value)} />
          <Select aria-label={t('rates.basis')} value={basis} onChange={(e) => setBasis(e.target.value as typeof basis)}>
            <option value="hour">{t('rates.perHour')}</option>
            <option value="year">{t('rates.perYear')}</option>
          </Select>
          <div className="flex gap-2">
            <Input aria-label={t('rates.from')} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <Button size="sm" onClick={addRate} disabled={busy} aria-label={t('rates.add')}>
              <Plus size={14} />
            </Button>
          </div>
        </div>
        <div className="mb-2 flex justify-end">
          <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
            <input type="checkbox" checked={showHistory} onChange={(e) => setShowHistory(e.target.checked)} />
            {t('rates.showHistory', { count: props.rates.filter((r) => r.effective_to).length })}
          </label>
        </div>
        <PagedTable
          rows={props.rates.filter((r) => showHistory || !r.effective_to)}
          rowKey={(r) => r.id}
          searchable
          pageSize={10}
          empty={
            <div className="py-6 text-center">
              <p className="text-sm text-slate-400">{t('rates.empty')}</p>
              <Button size="sm" variant="outline" className="mt-2" onClick={() => setWizardOpen(true)}>
                <Sparkles size={14} /> {t('checklist.launchWizard')}
              </Button>
            </div>
          }
          columns={[
            {
              key: 'scope',
              header: t('rates.scope'),
              cell: (r) => <span className={cn(r.effective_to && 'text-slate-400 dark:text-slate-500')}>{scopeLabel(r)}</span>,
              search: (r) => scopeLabel(r),
            },
            {
              key: 'rate',
              header: t('rates.rate'),
              cell: (r) => (
                <span className="tabular-nums">
                  ${Number(r.rate).toFixed(2)}
                  <span className="text-xs text-slate-400"> /{r.basis === 'year' ? t('rates.yr') : t('rates.hr')}</span>
                </span>
              ),
            },
            { key: 'from', header: t('rates.from'), cell: (r) => <span className="tabular-nums">{r.effective_from}</span> },
            { key: 'to', header: t('rates.to'), cell: (r) => <span className="tabular-nums">{r.effective_to ?? '—'}</span> },
            {
              key: 'actions',
              header: '',
              cell: (r) => (
                <button
                  type="button"
                  aria-label={t('rates.delete')}
                  className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950"
                  onClick={() => { if (confirm(t('rates.confirmDelete'))) void post({ action: 'delete-rate', id: r.id }) }}
                >
                  <Trash2 size={14} />
                </button>
              ),
            },
          ]}
        />
      </Card>

      {/* ---- estimate components ---- */}
      <Card title={t('components.title')} hint={t('components.hint')}>
        <div className="space-y-2">
          {components.map((c, i) => (
            <div key={i} className="grid grid-cols-12 items-center gap-2">
              <Input aria-label={t('components.name')} className="col-span-4" value={c.name} onChange={(e) => setComponent(i, { name: e.target.value })} />
              <Select aria-label={t('components.kind')} className="col-span-3" value={c.kind} onChange={(e) => setComponent(i, { kind: e.target.value as LaborCostComponent['kind'] })}>
                <option value="percent_of_wage">{t('components.percentOfWage')}</option>
                <option value="per_hour">{t('components.perHour')}</option>
                <option value="per_day">{t('components.perDay')}</option>
              </Select>
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
          {components.length === 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-md bg-slate-50 p-2.5 dark:bg-slate-800/60">
              <span className="text-xs text-slate-500 dark:text-slate-400">{t('components.presetLead')}</span>
              <Button size="sm" variant="outline" onClick={() => setComponents([{ key: 'burden', name: t('components.presetCaName'), kind: 'percent_of_wage', value: 13, scaleWithOvertime: true }])}>
                {t('components.presetCa')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setComponents([{ key: 'burden', name: t('components.presetUsName'), kind: 'percent_of_wage', value: 30, scaleWithOvertime: true }])}>
                {t('components.presetUs')}
              </Button>
            </div>
          )}
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
              <Select id="lc-wip" value={laborWip} onChange={(e) => setLaborWip(e.target.value)}>
                <option value="">—</option>
                {props.accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.label}</option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="lc-clr">{t('posting.laborClearing')}</Label>
              <Select id="lc-clr" value={laborClearing} onChange={(e) => setLaborClearing(e.target.value)}>
                <option value="">—</option>
                {props.accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.label}</option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="lc-var">{t('posting.payrollVariance')}</Label>
              <Select id="lc-var" value={payrollVariance} onChange={(e) => setPayrollVariance(e.target.value)}>
                <option value="">—</option>
                {props.accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.label}</option>
                ))}
              </Select>
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
              <PagedTable
                rows={rec.perProject}
                rowKey={(r) => r.projectId}
                pageSize={10}
                empty={null}
                columns={[
                  { key: 'project', header: t('reconciliation.project'), cell: (r) => r.name, search: (r) => r.name },
                  { key: 'standard', header: t('reconciliation.standardCost'), cell: (r) => <span className="tabular-nums">${Number(r.standard).toFixed(2)}</span> },
                ]}
              />
            )}
          </div>
        )}
      </Card>

      {/* ---- where the other pieces live ---- */}
      <div className="xl:col-span-2">
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            { href: '/admin/setup/overhead', key: 'overhead' },
            { href: '/admin/setup/item-rate-books', key: 'rateBooks' },
            { href: '/admin/setup/time-types', key: 'timeTypes' },
          ].map((l) => (
            <Link
              key={l.key}
              href={l.href}
              className="group rounded-lg border border-slate-200 bg-white p-3 transition-colors hover:border-teal-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-teal-700"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-900 dark:text-slate-100">{t(`related.${l.key}`)}</span>
                <ArrowRight size={14} className="text-slate-300 transition-colors group-hover:text-teal-600 dark:text-slate-600 dark:group-hover:text-teal-400" aria-hidden />
              </div>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{t(`related.${l.key}Hint`)}</p>
            </Link>
          ))}
        </div>
      </div>

      {/* ---- sticky unsaved-changes bar ---- */}
      {dirty && (
        <div className="fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
          <div className="flex items-center gap-3 rounded-full border border-slate-200 bg-white py-2 pl-4 pr-2 shadow-lg dark:border-slate-700 dark:bg-slate-900">
            <span className="text-sm text-slate-600 dark:text-slate-300">{t('unsaved')}</span>
            <Button size="sm" variant="ghost" onClick={discardChanges} disabled={busy}>{t('discard')}</Button>
            <Button size="sm" onClick={saveSettings} disabled={busy}>{t('save')}</Button>
          </div>
        </div>
      )}
    </div>
  )
}
