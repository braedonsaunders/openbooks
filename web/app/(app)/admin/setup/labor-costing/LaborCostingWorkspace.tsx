'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Plus, Trash2 } from 'lucide-react'
import { Badge, Button, Input, Label, SearchSelect, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea, UrlDrawer, cn } from '@openbooks/ui'
import { PagedTable } from '../../../../../components/paged-table'
import { SearchInput } from '../../../../../components/search-input'
import { FilterChips } from '../../../../../components/filter-bar'
import { Pagination } from '../../../../../components/pagination'
import { mergeHref } from '../../../../../lib/list-params'
import type { LaborCostComponent, LaborCostingSettings } from '@openbooks/engine/src/labor-costing.ts'
import { LaborCostingWizard } from './LaborCostingWizard'

export interface RateRow {
  id: string
  employee_party_id: string | null
  job_title: string | null
  trade_id: string | null
  department_id: string | null
  subsidiary_id: string | null
  currency: string
  rate: string
  basis: string
  annual_hours: string
  effective_from: string
  effective_to: string | null
  notes: string | null
  employee_name: string | null
  trade_name: string | null
  department_name: string | null
  subsidiary_name: string | null
}

interface Opt {
  id: string
  name: string
}

interface SubsidiaryOpt extends Opt {
  currency: string
}

type ScopeKind = 'job_title' | 'trade' | 'department' | 'subsidiary' | 'org'

const today = () => {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function rateState(row: RateRow): 'current' | 'scheduled' | 'ended' {
  const date = today()
  if (row.effective_from > date) return 'scheduled'
  if (row.effective_to && row.effective_to < date) return 'ended'
  return 'current'
}

function formatRate(value: string, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      currencyDisplay: 'code',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number(value))
  } catch {
    return `${currency} ${Number(value).toFixed(2)}`
  }
}

/** Mirror of engine computeCostRate for the live preview (display only). */
function previewRate(wage: number, mult: number, s: { hoursPerDay: number; components: LaborCostComponent[] }): number {
  let rate = wage * mult
  for (const c of s.components) {
    const v = Number(c.value)
    if (!Number.isFinite(v) || v === 0) continue
    if (c.kind === 'percent_of_wage' || c.kind === 'worker_comp') rate += (c.scaleWithOvertime ? wage * mult : wage) * (v / 100)
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
  view: 'rates' | 'components' | 'posting' | 'reconciliation'
  settings: LaborCostingSettings
  rates: RateRow[]
  selectedRate: RateRow | null
  creatingRate: boolean
  guideOpen: boolean
  currentParams: Record<string, string | string[] | undefined>
  totalRates: number
  ratePage: number
  ratePerPage: number
  trades: Opt[]
  departments: Opt[]
  subsidiaries: SubsidiaryOpt[]
  defaultSubsidiary: SubsidiaryOpt | null
  jobTitles: string[]
  accounts: { id: string; label: string }[]
  currencies: string[]
  orgCurrency: string
  laborWip: string | null
  laborClearing: string | null
  payrollVariance: string | null
  coverage: { employees: number; covered: number; hasOrgDefault: boolean }
}) {
  const locale = useLocale()
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
    }),
  )
  const currentSnap = makeSnap({
    mode,
    hoursPerDay,
    annualHours,
    components,
    laborWip,
    laborClearing,
    payrollVariance,
  })
  const dirty = currentSnap !== savedSnap

  // ---- reconciliation state ------------------------------------------------
  const now = new Date()
  const lastMonth = new Date(Date.UTC(now.getFullYear(), now.getMonth() - 1, 1))
  const lastMonthEnd = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 0))
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const [recFrom, setRecFrom] = useState(iso(lastMonth))
  const [recTo, setRecTo] = useState(iso(lastMonthEnd))
  const [recSubsidiaryId, setRecSubsidiaryId] = useState(props.subsidiaries[0]?.id ?? props.defaultSubsidiary?.id ?? '')
  const [rec, setRec] = useState<{
    subsidiaryId: string
    currency: string
    standardPosted: string
    payrollPosted: string
    periodVariance: string
    openBalance: string
    perProject: { projectId: string; name: string; standard: string }[]
  } | null>(null)
  const reconciliationCurrency = props.subsidiaries.find((subsidiary) => subsidiary.id === recSubsidiaryId)?.currency
    ?? props.defaultSubsidiary?.currency
    ?? props.orgCurrency

  // Fixed adders are configured in org base currency, so the illustrative
  // wage must also be base currency (never borrow a foreign wage row).
  const exampleWage = 40
  const live = { hoursPerDay: Number(hoursPerDay) || 8, components }

  async function saveSettings() {
    setBusy(true)
    try {
      const res = await fetch('/api/admin/setup/labor-costing', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settings: {
            mode,
            hoursPerDay: Number(hoursPerDay),
            annualHours: Number(annualHours),
            components,
          },
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

  async function loadReconciliation() {
    setBusy(true)
    try {
      const res = await fetch('/api/admin/setup/labor-costing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'reconcile',
          periodStart: recFrom,
          periodEnd: recTo,
          subsidiaryId: recSubsidiaryId,
        }),
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
        body: JSON.stringify({
          action: 'post-variance',
          periodStart: recFrom,
          periodEnd: recTo,
          subsidiaryId: recSubsidiaryId,
        }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'failed')
      toast.success(
        t('reconciliation.variancePosted', {
          amount: formatRate(String(j.variance), reconciliationCurrency, locale),
        }),
      )
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

  const scopeLabel = (r: RateRow) => r.employee_name
    ?? (r.job_title ? `${t('rates.scopeJobTitle')}: ${r.job_title}`
      : r.trade_name ? `${t('rates.scopeTrade')}: ${r.trade_name}`
        : r.department_name ? `${t('rates.scopeDepartment')}: ${r.department_name}`
          : r.subsidiary_name ? `${t('rates.scopeSubsidiary')}: ${r.subsidiary_name}`
            : t('orgDefault'))

  const steps = [
    {
      key: 'wages',
      done: props.coverage.employees > 0 && props.coverage.covered === props.coverage.employees,
      detail: t('checklist.wagesDetail', {
        covered: props.coverage.covered,
        total: props.coverage.employees,
      }),
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

  const view = props.view
  const basePath = '/admin/setup/labor-costing'
  const guideCloseHref = mergeHref(basePath, props.currentParams, {
    guide: undefined,
  })
  const rateCloseHref = mergeHref(basePath, props.currentParams, {
    rate: undefined,
  })
  const newRateHref = mergeHref(basePath, props.currentParams, {
    rate: 'new',
    guide: undefined,
  })
  return (
    <div className="space-y-4">
      <LaborCostingWizard
        open={props.guideOpen}
        closeHref={guideCloseHref}
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
        accounts={props.accounts}
        hoursPerDay={Number(hoursPerDay) || 8}
        annualHours={Number(annualHours) || 2080}
      />

      {/* ---- guided status ---- */}
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="grid min-w-[760px] grid-cols-4 divide-x divide-slate-200 dark:divide-slate-800">
          {steps.map((st, i) => (
            <div key={st.key} className="p-3">
              <div className="mb-1 flex items-center gap-2">
                <span
                  className={cn(
                    'grid h-5 w-5 place-items-center rounded-full text-[11px] font-semibold',
                    st.done ? 'bg-teal-600 text-white dark:bg-teal-500 dark:text-slate-950' : 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-200',
                  )}
                >
                  {st.done ? '✓' : i + 1}
                </span>
                <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t(`checklist.${st.key}`)}</span>
              </div>
              <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">{st.detail}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ---- wage rates ---- */}
      {view === 'rates' && (
        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('rates.title')}</h3>
            <p className="mt-0.5 max-w-4xl text-xs text-slate-500 dark:text-slate-400">{t('rates.hint')}</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <SearchInput placeholder={t('rates.search')} />
            <FilterChips
              basePath={basePath}
              currentParams={props.currentParams}
              paramKey="rateScope"
              label={t('rates.scope')}
              options={[
                { value: 'job_title', label: t('rates.scopeJobTitle') },
                { value: 'trade', label: t('rates.scopeTrade') },
                { value: 'department', label: t('rates.scopeDepartment') },
                ...(props.subsidiaries.length > 0 ? [{ value: 'subsidiary', label: t('rates.scopeSubsidiary') }] : []),
                { value: 'org', label: t('rates.scopeOrg') },
              ]}
            />
            <FilterChips
              basePath={basePath}
              currentParams={props.currentParams}
              paramKey="rateStatus"
              label={t('rates.status')}
              defaultValue="active"
              options={[
                { value: 'active', label: t('rates.statusActive') },
                { value: 'current', label: t('rates.statusCurrent') },
                { value: 'scheduled', label: t('rates.statusScheduled') },
                { value: 'ended', label: t('rates.statusEnded') },
              ]}
            />
            <Button asChild size="sm" className="sm:ml-auto">
              <Link href={newRateHref as never}>
                <Plus size={14} /> {t('rates.add')}
              </Link>
            </Button>
          </div>

          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('rates.scope')}</TableHead>
                  <TableHead className="text-right">{t('rates.rate')}</TableHead>
                  <TableHead>{t('rates.from')}</TableHead>
                  <TableHead>{t('rates.to')}</TableHead>
                  <TableHead>{t('rates.status')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {props.rates.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-10 text-center text-slate-500 dark:text-slate-400">
                      <p>{t('rates.emptyFiltered')}</p>
                      <Button asChild variant="outline" size="sm" className="mt-3">
                        <Link href={newRateHref as never}>
                          <Plus size={14} /> {t('rates.add')}
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ) : null}
                {props.rates.map((row) => {
                  const href = mergeHref(basePath, props.currentParams, {
                    rate: row.id,
                    guide: undefined,
                  })
                  const status = rateState(row)
                  return (
                    <TableRow
                      key={row.id}
                      className="cursor-pointer"
                      tabIndex={0}
                      aria-label={t('rates.openRate', {
                        scope: scopeLabel(row),
                      })}
                      onClick={() => router.push(href)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') router.push(href)
                      }}
                    >
                      <TableCell>
                        <Link href={href as never} className="font-medium text-teal-700 hover:underline dark:text-teal-300" onClick={(event) => event.stopPropagation()}>
                          {scopeLabel(row)}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatRate(row.rate, row.currency, locale)}
                        <span className="ml-1 text-xs text-slate-400">/{row.basis === 'year' ? t('rates.yr') : t('rates.hr')}</span>
                      </TableCell>
                      <TableCell className="tabular-nums">{row.effective_from}</TableCell>
                      <TableCell className="tabular-nums">{row.effective_to ?? '—'}</TableCell>
                      <TableCell>
                        <Badge variant={status === 'current' ? 'success' : status === 'scheduled' ? 'default' : 'outline'}>
                          {t(status === 'current' ? 'rates.statusCurrent' : status === 'scheduled' ? 'rates.statusScheduled' : 'rates.statusEnded')}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
            {props.totalRates > 0 ? <Pagination basePath={basePath} currentParams={props.currentParams} total={props.totalRates} page={props.ratePage} perPage={props.ratePerPage} /> : null}
          </div>
          <p className="rounded-md bg-slate-50 p-2.5 text-xs text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
            {t('rates.employeeNote', {
              covered: props.coverage.covered,
              total: props.coverage.employees,
            })}
          </p>
        </section>
      )}

      {props.creatingRate || props.selectedRate ? (
        <RateDrawer
          key={props.selectedRate?.id ?? 'new'}
          row={props.selectedRate}
          trades={props.trades}
          departments={props.departments}
          subsidiaries={props.subsidiaries}
          jobTitles={props.jobTitles}
          defaultAnnualHours={Number(annualHours) || 2080}
          currencies={props.currencies}
          orgCurrency={props.orgCurrency}
          closeHref={rateCloseHref}
        />
      ) : null}

      {/* ---- estimate components ---- */}
      {view === 'components' && (
        <Card title={t('components.title')} hint={t('components.hint')}>
          <div className="space-y-2">
            {components.map((c, i) => (
              <div key={i} className="grid grid-cols-12 items-center gap-2">
                <Input aria-label={t('components.name')} className="col-span-4" value={c.name} onChange={(e) => setComponent(i, { name: e.target.value })} />
                <Select
                  aria-label={t('components.kind')}
                  className="col-span-3"
                  value={c.kind}
                  onChange={(e) =>
                    setComponent(i, {
                      kind: e.target.value as LaborCostComponent['kind'],
                    })
                  }
                >
                  <option value="percent_of_wage">{t('components.percentOfWage')}</option>
                  <option value="worker_comp">{t('components.workerComp')}</option>
                  <option value="per_hour">{t('components.perHour')}</option>
                  <option value="per_day">{t('components.perDay')}</option>
                </Select>
                <Input aria-label={t('components.value')} className="col-span-2" type="number" min="0" step="0.01" value={String(c.value)} onChange={(e) => setComponent(i, { value: Number(e.target.value) })} />
                <label className="col-span-2 flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                  <input type="checkbox" checked={c.scaleWithOvertime === true} onChange={(e) => setComponent(i, { scaleWithOvertime: e.target.checked })} disabled={c.kind === 'per_day'} />
                  {t('components.scalesOt')}
                </label>
                <button
                  type="button"
                  aria-label={t('components.remove')}
                  className="col-span-1 rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950"
                  onClick={() => setComponents((cs) => cs.filter((_, j) => j !== i))}
                >
                  <Trash2 size={14} />
                </button>
                {c.kind === 'worker_comp' && (
                  <p className="col-span-12 -mt-1 text-xs text-slate-400 dark:text-slate-500">{t('components.workerCompHint')}</p>
                )}
              </div>
            ))}
            {components.length === 0 && (
              <div className="flex flex-wrap items-center gap-2 rounded-md bg-slate-50 p-2.5 dark:bg-slate-800/60">
                <span className="text-xs text-slate-500 dark:text-slate-400">{t('components.presetLead')}</span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setComponents([
                      {
                        key: 'burden',
                        name: t('components.presetCaName'),
                        kind: 'percent_of_wage',
                        value: 13,
                        scaleWithOvertime: true,
                      },
                    ])
                  }
                >
                  {t('components.presetCa')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setComponents([
                      {
                        key: 'burden',
                        name: t('components.presetUsName'),
                        kind: 'percent_of_wage',
                        value: 30,
                        scaleWithOvertime: true,
                      },
                    ])
                  }
                >
                  {t('components.presetUs')}
                </Button>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setComponents((cs) => [
                    ...cs,
                    {
                      key: `c${cs.length}`,
                      name: t('components.newBurden'),
                      kind: 'percent_of_wage',
                      value: 13,
                      scaleWithOvertime: true,
                    },
                  ])
                }
              >
                <Plus size={14} /> {t('components.addBurden')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setComponents((cs) => [
                    ...cs,
                    {
                      key: `c${cs.length}`,
                      name: t('components.newPerDiem'),
                      kind: 'per_day',
                      value: 0,
                    },
                  ])
                }
              >
                <Plus size={14} /> {t('components.addPerDiem')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setComponents((cs) => [
                    ...cs,
                    {
                      key: `c${cs.length}`,
                      name: t('components.newWorkerComp'),
                      kind: 'worker_comp',
                      value: 0,
                      scaleWithOvertime: true,
                    },
                  ])
                }
              >
                <Plus size={14} /> {t('components.addWorkerComp')}
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
                <span>
                  {t('components.exampleReg')}: {formatRate(String(previewRate(exampleWage, 1, live)), props.orgCurrency, locale)}/h
                </span>
                <span>
                  {t('components.exampleOt')}: {formatRate(String(previewRate(exampleWage, 1.5, live)), props.orgCurrency, locale)}/h
                </span>
                <span>
                  {t('components.exampleDt')}: {formatRate(String(previewRate(exampleWage, 2, live)), props.orgCurrency, locale)}/h
                </span>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* ---- posting ---- */}
      {view === 'posting' && (
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
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="lc-clr">{t('posting.laborClearing')}</Label>
                <Select id="lc-clr" value={laborClearing} onChange={(e) => setLaborClearing(e.target.value)}>
                  <option value="">—</option>
                  {props.accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="lc-var">{t('posting.payrollVariance')}</Label>
                <Select id="lc-var" value={payrollVariance} onChange={(e) => setPayrollVariance(e.target.value)}>
                  <option value="">—</option>
                  {props.accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('posting.overheadNote')}</p>
          </div>
        </Card>
      )}

      {/* ---- payroll reconciliation ---- */}
      {view === 'reconciliation' && (
        <Card title={t('reconciliation.title')} hint={t('reconciliation.hint')}>
          <div className="flex flex-wrap items-end gap-2">
            {props.subsidiaries.length > 0 ? <div>
              <Label htmlFor="rec-subsidiary">{t('reconciliation.subsidiary')}</Label>
              <Select
                id="rec-subsidiary"
                value={recSubsidiaryId}
                onChange={(event) => {
                  setRecSubsidiaryId(event.target.value)
                  setRec(null)
                }}
              >
                {props.subsidiaries.map((subsidiary) => (
                  <option key={subsidiary.id} value={subsidiary.id}>{subsidiary.name} · {subsidiary.currency}</option>
                ))}
              </Select>
            </div> : null}
            <div>
              <Label htmlFor="rec-from">{t('reconciliation.from')}</Label>
              <Input id="rec-from" type="date" value={recFrom} onChange={(e) => setRecFrom(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="rec-to">{t('reconciliation.to')}</Label>
              <Input id="rec-to" type="date" value={recTo} onChange={(e) => setRecTo(e.target.value)} />
            </div>
            <Button size="sm" variant="outline" onClick={loadReconciliation} disabled={busy}>
              {t('reconciliation.load')}
            </Button>
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
                      {formatRate(v, rec.currency, locale)}
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
                    {
                      key: 'project',
                      header: t('reconciliation.project'),
                      cell: (r) => r.name,
                      search: (r) => r.name,
                    },
                    {
                      key: 'standard',
                      header: t('reconciliation.standardCost'),
                      cell: (r) => <span className="tabular-nums">{formatRate(r.standard, rec.currency, locale)}</span>,
                    },
                  ]}
                />
              )}
            </div>
          )}
        </Card>
      )}

      {/* ---- sticky unsaved-changes bar ---- */}
      {dirty && (
        <div className="fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
          <div className="flex items-center gap-3 rounded-full border border-slate-200 bg-white py-2 pl-4 pr-2 shadow-lg dark:border-slate-700 dark:bg-slate-900">
            <span className="text-sm text-slate-600 dark:text-slate-300">{t('unsaved')}</span>
            <Button size="sm" variant="ghost" onClick={discardChanges} disabled={busy}>
              {t('discard')}
            </Button>
            <Button size="sm" onClick={saveSettings} disabled={busy}>
              {t('save')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function RateDrawer({
  row,
  trades,
  departments,
  subsidiaries,
  jobTitles,
  defaultAnnualHours,
  currencies,
  orgCurrency,
  closeHref,
}: {
  row: RateRow | null
  trades: Opt[]
  departments: Opt[]
  subsidiaries: SubsidiaryOpt[]
  jobTitles: string[]
  defaultAnnualHours: number
  currencies: string[]
  orgCurrency: string
  closeHref: string
}) {
  const locale = useLocale()
  const t = useTranslations('admin.setup.laborCosting')
  const tc = useTranslations('common')
  const router = useRouter()
  const creating = !row
  const [busy, setBusy] = useState(false)
  const [scope, setScope] = useState<ScopeKind>(() => row
    ? row.job_title ? 'job_title' : row.trade_id ? 'trade' : row.department_id ? 'department' : row.subsidiary_id ? 'subsidiary' : 'org'
    : jobTitles.length ? 'job_title' : trades.length ? 'trade' : departments.length ? 'department' : subsidiaries.length > 1 ? 'subsidiary' : 'org')
  const [jobTitle, setJobTitle] = useState(row?.job_title ?? '')
  const [tradeId, setTradeId] = useState(row?.trade_id ?? '')
  const [departmentId, setDepartmentId] = useState(row?.department_id ?? '')
  const [subsidiaryId, setSubsidiaryId] = useState(row?.subsidiary_id ?? '')
  const [currency, setCurrency] = useState(row?.currency ?? orgCurrency)
  const [rate, setRate] = useState(row?.rate ?? '')
  const [basis, setBasis] = useState<'hour' | 'year'>(() => (row?.basis === 'year' ? 'year' : 'hour'))
  const [annualHours, setAnnualHours] = useState(row?.annual_hours ?? String(defaultAnnualHours))
  const [effectiveFrom, setEffectiveFrom] = useState(row?.effective_from ?? today())
  const [effectiveTo, setEffectiveTo] = useState(row?.effective_to ?? '')
  const [notes, setNotes] = useState(row?.notes ?? '')

  async function call(body: Record<string, unknown>) {
    const response = await fetch('/api/admin/setup/labor-costing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error((await response.json()).error ?? tc('feedback.saveFailed'))
  }

  async function save() {
    if (rate === '' || !Number.isFinite(Number(rate)) || Number(rate) < 0) {
      toast.error(t('rateRequired'))
      return
    }
    const selectedScope = scope === 'job_title' ? jobTitle : scope === 'trade' ? tradeId : scope === 'department' ? departmentId : scope === 'subsidiary' ? subsidiaryId : 'org'
    if (!selectedScope) {
      toast.error(t('scopeRequired'))
      return
    }
    if (basis === 'year' && (!Number.isFinite(Number(annualHours)) || Number(annualHours) <= 0)) {
      toast.error(t('rates.annualHoursRequired'))
      return
    }
    if (effectiveTo && effectiveTo < effectiveFrom) {
      toast.error(t('rates.invalidEndDate'))
      return
    }
    setBusy(true)
    try {
      await call({
        action: 'save-rate',
        employeePartyId: null,
        jobTitle: scope === 'job_title' ? jobTitle : null,
        tradeId: scope === 'trade' ? tradeId : null,
        departmentId: scope === 'department' ? departmentId : null,
        subsidiaryId: scope === 'subsidiary' ? subsidiaryId : null,
        currency,
        rate: Number(rate),
        basis,
        annualHours: Number(annualHours) || defaultAnnualHours,
        effectiveFrom,
        notes: notes.trim() || null,
      })
      if (row) {
        await call({
          action: 'end-rate',
          id: row.id,
          effectiveTo: effectiveTo || null,
        })
      }
      toast.success(t(creating ? 'rateSaved' : 'rates.rateUpdated'))
      router.push(closeHref)
      router.refresh()
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!row || !confirm(t('rates.confirmDelete'))) return
    setBusy(true)
    try {
      await call({ action: 'delete-rate', id: row.id })
      toast.success(t('rates.rateDeleted'))
      router.push(closeHref)
      router.refresh()
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const scopeName = row?.job_title ?? row?.trade_name ?? row?.department_name ?? row?.subsidiary_name ?? t('orgDefault')
  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="lg"
      title={t(creating ? 'rates.drawerNewTitle' : 'rates.drawerEditTitle')}
      description={creating ? t('rates.drawerNewDescription') : t('rates.drawerEditDescription', { scope: scopeName })}
      headerActions={
        <Button disabled={busy} onClick={save}>
          {busy ? tc('actions.saving') : tc(creating ? 'actions.create' : 'actions.save')}
        </Button>
      }
      footer={
        row ? (
          <button type="button" disabled={busy} onClick={remove} className="flex items-center gap-1.5 text-sm text-red-600 hover:text-red-700 disabled:opacity-50 dark:text-red-400">
            <Trash2 size={14} /> {tc('actions.delete')}
          </button>
        ) : (
          <span />
        )
      }
    >
      <div className="grid gap-4 p-1 sm:grid-cols-2">
        <div>
          <Label htmlFor="rate-scope">{t('rates.scope')}</Label>
          <Select
            id="rate-scope"
            value={scope}
            disabled={!creating}
            onChange={(event) => {
              const next = event.target.value as ScopeKind
              setScope(next)
              setJobTitle('')
              setTradeId('')
              setDepartmentId('')
              setSubsidiaryId('')
            }}
          >
            <option value="job_title">{t('rates.scopeJobTitle')}</option>
            <option value="trade">{t('rates.scopeTrade')}</option>
            <option value="department">{t('rates.scopeDepartment')}</option>
            {subsidiaries.length > 0 ? <option value="subsidiary">{t('rates.scopeSubsidiary')}</option> : null}
            <option value="org">{t('rates.scopeOrg')}</option>
          </Select>
        </div>
        {scope !== 'org' ? (
          <div>
            <Label>{t('rates.who')}</Label>
            {scope === 'job_title' ? (
              <>
                <Input
                  value={jobTitle}
                  onChange={(event) => setJobTitle(event.target.value)}
                  disabled={!creating}
                  placeholder={t('rates.select.job_title')}
                  list="labor-job-titles"
                />
                <datalist id="labor-job-titles">
                  {jobTitles.map((title) => <option key={title} value={title} />)}
                </datalist>
              </>
            ) : (
            <SearchSelect
              value={scope === 'trade' ? tradeId : scope === 'department' ? departmentId : subsidiaryId}
              onChange={(value) => {
                if (scope === 'trade') setTradeId(value)
                else if (scope === 'department') setDepartmentId(value)
                else {
                  setSubsidiaryId(value)
                  const selected = subsidiaries.find((subsidiary) => subsidiary.id === value)
                  if (selected && creating) setCurrency(selected.currency)
                }
              }}
              options={(scope === 'trade'
                  ? trades.map((trade) => ({ value: trade.id, label: trade.name }))
                  : scope === 'department'
                    ? departments.map((department) => ({ value: department.id, label: department.name }))
                    : subsidiaries.map((subsidiary) => ({ value: subsidiary.id, label: subsidiary.name }))) }
              disabled={!creating}
              searchable
              placeholder={t(`rates.select.${scope}`)}
              ariaLabel={t(`rates.select.${scope}`)}
              sheetTitle={t(`rates.select.${scope}`)}
            />
            )}
          </div>
        ) : (
          <div />
        )}
        <div>
          <Label htmlFor="rate-value">{t('rates.rate')}</Label>
          <Input id="rate-value" type="number" min="0" step="0.0001" value={rate} onChange={(event) => setRate(event.target.value)} />
        </div>
        {currencies.length > 1 ? (
          <div>
            <Label htmlFor="rate-currency">{t('rates.currency')}</Label>
            <Select id="rate-currency" value={currency} onChange={(event) => setCurrency(event.target.value)}>
              {currencies.map((code) => <option key={code} value={code}>{code}</option>)}
            </Select>
          </div>
        ) : null}
        <div>
          <Label htmlFor="rate-basis">{t('rates.basis')}</Label>
          <Select id="rate-basis" value={basis} onChange={(event) => setBasis(event.target.value as 'hour' | 'year')}>
            <option value="hour">{t('rates.perHour')}</option>
            <option value="year">{t('rates.perYear')}</option>
          </Select>
        </div>
        {basis === 'year' ? (
          <div>
            <Label htmlFor="rate-annual-hours">{t('rates.annualHours')}</Label>
            <Input id="rate-annual-hours" type="number" min="1" step="1" value={annualHours} onChange={(event) => setAnnualHours(event.target.value)} />
            {rate ? (
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {t('rates.hourlyEquivalent', {
                  amount: formatRate(String(Number(rate) / (Number(annualHours) || defaultAnnualHours)), currency, locale),
                })}
              </p>
            ) : null}
          </div>
        ) : null}
        <div>
          <Label htmlFor="rate-from">{t('rates.from')}</Label>
          <Input id="rate-from" type="date" value={effectiveFrom} disabled={!creating} onChange={(event) => setEffectiveFrom(event.target.value)} />
        </div>
        {!creating ? (
          <div>
            <Label htmlFor="rate-to">{t('rates.to')}</Label>
            <Input id="rate-to" type="date" min={effectiveFrom} value={effectiveTo} onChange={(event) => setEffectiveTo(event.target.value)} />
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('rates.endDateHint')}</p>
          </div>
        ) : null}
        <div className="sm:col-span-2">
          <Label htmlFor="rate-notes">{t('rates.notes')}</Label>
          <Textarea id="rate-notes" rows={4} maxLength={500} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </div>
      </div>
    </UrlDrawer>
  )
}
