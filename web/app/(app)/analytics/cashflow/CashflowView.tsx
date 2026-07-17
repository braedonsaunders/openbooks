'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  University,
  Wallet,
  TriangleAlert,
  ArrowDown,
  ArrowUp,
  Flame,
  ShieldCheck,
  RefreshCw,
  ArrowLeftRight,
  Route,
  Waypoints,
  AreaChart,
  ChevronRight,
  ChevronDown,
  ListOrdered,
  SlidersHorizontal,
  History,
  Gauge as GaugeIcon,
} from 'lucide-react'
import { cn, Drawer, Badge, Select } from '@openbooks/ui'
import type { CashflowData, WeekRow, SideSummary, ForecastCategory } from '../../../../lib/analytics/cashflow-data'
import { TxnLink } from '../../reports/TxnLink'
import { ConfigEditor } from '../_ui/ConfigEditor'
import { Panel } from '../_ui/Panel'
import { TrendChart, Chart } from '../_ui/charts'
import { fmtMoney } from '../_ui/format'

const TABS = ['overview', 'weekly', 'category', 'config'] as const
type Tab = (typeof TABS)[number]
const TAB_LABEL: Record<Tab, string> = { overview: 'Overview', weekly: 'Weekly Timeline', category: 'Category Analysis', config: 'Configuration' }

const money = (n: number) => fmtMoney(n, { compact: true })
const BUCKET_COLORS: Record<string, string> = { Current: '#10b981', '1-30': '#14b8a6', '31-60': '#0ea5e9', '61-90': '#f59e0b', '90+': '#ef4444' }

export function CashflowView({ data }: { data: CashflowData }) {
  const [tab, setTab] = useState<Tab>('overview')
  const s = data.summary

  return (
    <div className="space-y-5">
      {/* KPI row — Gantry: Current Cash / Projected End / Lowest Point / Inflows / Outflows */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Kpi icon={University} accent="slate" label="Current Cash" value={money(s.startingCash)} tone={s.startingCash < 0 ? 'neg' : undefined} />
        <Kpi icon={Wallet} accent="sky" label="Projected End" value={money(s.projectedEnd)} sub={`${s.netChange >= 0 ? '+' : ''}${money(s.netChange)} net`} tone={s.netChange >= 0 ? 'pos' : 'neg'} />
        <Kpi icon={TriangleAlert} accent={s.lowestCash < 0 ? 'red' : 'amber'} label="Lowest Point" value={money(s.lowestCash)} sub={new Date(s.lowestWeek + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} tone={s.lowestCash < 0 ? 'neg' : undefined} />
        <Kpi icon={ArrowDown} accent="emerald" label="Inflows" value={money(s.totalInflows)} tone="pos" />
        <Kpi icon={ArrowUp} accent="red" label="Outflows" value={money(s.totalOutflows)} tone="neg" />
      </div>

      <div className="-mx-1 overflow-x-auto">
        <div className="flex min-w-max gap-0.5 border-b border-slate-200 px-1 dark:border-slate-800">
          {TABS.map((k) => (
            <button key={k} type="button" onClick={() => setTab(k)} className={cn('-mb-px shrink-0 border-b-2 px-3.5 py-2 text-sm font-medium transition-colors', tab === k ? 'border-teal-500 text-teal-600 dark:text-teal-400' : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200')}>
              {TAB_LABEL[k]}
            </button>
          ))}
        </div>
      </div>

      <div key={tab}>
        {tab === 'overview' ? <OverviewTab data={data} /> : null}
        {tab === 'weekly' ? <WeeklyTab data={data} /> : null}
        {tab === 'category' ? <CategoryTab data={data} /> : null}
        {tab === 'config' ? <ConfigTab data={data} /> : null}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- Overview */
function OverviewTab({ data }: { data: CashflowData }) {
  const s = data.summary
  const bridgeOption = useMemo(() => cashBridgeOption(s.startingCash, s.totalInflows, s.totalOutflows, s.projectedEnd), [s])

  return (
    <div className="space-y-5">
      {/* Vitals hero */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <Vital icon={Flame} ring="from-violet-500 to-fuchsia-500" label="Cash Burn Rate" value={money(s.burnRate)} hint="Avg weekly outflow" badge="Weekly" />
        <Vital icon={ShieldCheck} ring="from-sky-500 to-blue-500" label="AR Coverage" value={s.arCoverage === null ? '—' : `${s.arCoverage.toFixed(2)}×`} hint="(Cash + AR) / AP" />
        <Vital icon={RefreshCw} ring="from-teal-500 to-emerald-500" label="Cash Cycle" value={`${s.dso ?? '—'} / ${s.dpo ?? '—'}`} hint="DSO / DPO" split />
        <Vital icon={ArrowLeftRight} ring={s.netChange >= 0 ? 'from-emerald-500 to-teal-500' : 'from-red-500 to-orange-500'} label="Net Period Flow" value={money(s.netChange)} hint="Inflows − Outflows" />
        <Vital icon={Route} ring="from-indigo-500 to-violet-500" label="Cash Runway" value={s.runwayWeeks === null ? '∞' : `${s.runwayWeeks.toFixed(1)}w`} hint={s.runwayStatus === 'critical' ? 'Critical' : s.runwayStatus === 'caution' ? 'Caution' : 'Healthy'} status={s.runwayStatus} />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Panel title="Cash Flow Bridge" icon={Waypoints}>
          <Chart option={bridgeOption} height={260} />
        </Panel>
        <Panel title="Cash Position Forecast" icon={AreaChart}>
          <TrendChart labels={data.weeks.map((w) => w.label.split(' – ')[0])} area height={260} series={[{ name: 'Ending cash', data: data.weeks.map((w) => w.endingCash), color: '#0d9488' }]} />
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <AgingPanel title="Accounts Receivable" side={data.ar} accent="text-sky-600 dark:text-sky-400" />
        <AgingPanel title="Accounts Payable" side={data.ap} accent="text-red-600 dark:text-red-400" />
      </div>
    </div>
  )
}

function AgingPanel({ title, side, accent }: { title: string; side: SideSummary; accent: string }) {
  const total = side.outstanding || 1
  return (
    <Panel title={title} icon={ListOrdered} hint={`${money(side.outstanding)} · ${side.pctCurrent.toFixed(0)}% current`}>
      <div className="space-y-2">
        {side.buckets.map((b) => (
          <div key={b.label}>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
                <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: BUCKET_COLORS[b.label] }} />
                {b.label}
              </span>
              <span className={cn('tabular-nums', accent)}>{money(b.amount)}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
              <div className="h-full rounded-full" style={{ width: `${Math.max(0, (b.amount / total) * 100)}%`, backgroundColor: BUCKET_COLORS[b.label] }} />
            </div>
          </div>
        ))}
      </div>
    </Panel>
  )
}

/* ----------------------------------------------------------- Weekly Timeline */
function WeeklyTab({ data }: { data: CashflowData }) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [flyout, setFlyout] = useState<{ week: WeekRow; side: 'ar' | 'ap' } | null>(null)
  const toggle = (k: string) => setOpen((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n })
  const hasCats = data.categories.length > 0
  const scheduling = data.apSettings.weeklyCap > 0 || data.apSettings.restrictToSafe
  const cols = 6 + (hasCats ? 2 : 0) + (scheduling ? 1 : 0)

  return (
    <>
      {scheduling && data.deferredBeyondHorizon > 0 ? (
        <p className="mb-4 flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          <ListOrdered size={14} className="mt-0.5 shrink-0" />
          <span><span className="font-semibold">{money(data.deferredBeyondHorizon)} of payables can&apos;t be paid within the horizon</span> under the current AP capacity settings — the backlog spills past the last week.</span>
        </p>
      ) : null}
      <Panel
        title="Forecast Model"
        icon={ListOrdered}
        hint={scheduling ? `Click a week for its transactions · AP scheduled oldest-due-first up to ${data.apSettings.weeklyCap > 0 ? money(data.apSettings.weeklyCap) : 'safe capacity'} per week` : 'Click a week to see the transactions behind it'}
        bodyClassName="p-0"
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
              <th className="w-8 px-2 py-2" />
              <th className="px-3 py-2 text-left font-medium">Week</th>
              <th className="px-3 py-2 text-right font-medium">Inflows</th>
              <th className="px-3 py-2 text-right font-medium">Outflows</th>
              {hasCats ? <th className="px-3 py-2 text-right font-medium">Other In</th> : null}
              {hasCats ? <th className="px-3 py-2 text-right font-medium">Other Out</th> : null}
              {scheduling ? <th className="px-3 py-2 text-right font-medium">Deferred</th> : null}
              <th className="px-3 py-2 text-right font-medium">Net</th>
              <th className="px-3 py-2 text-right font-medium">Ending Cash</th>
            </tr>
          </thead>
          <tbody>
            {data.weeks.map((w) => {
              const isOpen = open.has(w.weekStart)
              return (
                <FragmentRows key={w.weekStart}>
                  <tr className="cursor-pointer border-b border-slate-50 hover:bg-slate-50/60 dark:border-slate-800/60 dark:hover:bg-slate-800/30" onClick={() => toggle(w.weekStart)}>
                    <td className="px-2 py-2.5 text-center text-slate-400">{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                    <td className="px-3 py-2.5 font-medium text-slate-800 dark:text-slate-200">{w.label}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-emerald-600 dark:text-emerald-400">{w.inflow > 0 ? money(w.inflow) : '—'}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-red-600 dark:text-red-400">{w.outflow > 0 ? money(w.outflow) : '—'}</td>
                    {hasCats ? <td className="px-3 py-2.5 text-right tabular-nums text-emerald-600/80 dark:text-emerald-400/80">{w.dynamicInflow > 0 ? money(w.dynamicInflow) : '—'}</td> : null}
                    {hasCats ? <td className="px-3 py-2.5 text-right tabular-nums text-red-600/80 dark:text-red-400/80">{w.dynamicOutflow > 0 ? money(w.dynamicOutflow) : '—'}</td> : null}
                    {scheduling ? <td className="px-3 py-2.5 text-right tabular-nums text-amber-600 dark:text-amber-400">{w.deferredOut > 0 ? money(w.deferredOut) : '—'}</td> : null}
                    <td className={cn('px-3 py-2.5 text-right font-medium tabular-nums', w.net >= 0 ? 'text-slate-800 dark:text-slate-200' : 'text-red-600 dark:text-red-400')}>{money(w.net)}</td>
                    <td className={cn('px-3 py-2.5 text-right font-bold tabular-nums', w.endingCash < 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-slate-100')}>{money(w.endingCash)}</td>
                  </tr>
                  {isOpen ? (
                    <tr className="bg-slate-50/40 dark:bg-slate-800/20">
                      <td />
                      <td colSpan={cols - 1} className="px-3 py-2">
                        <div className="flex flex-wrap gap-2 text-xs">
                          <button type="button" onClick={() => setFlyout({ week: w, side: 'ar' })} className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 font-medium text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300">
                            {w.arEntries.length} AR inflows · {money(w.arEntries.reduce((a, e) => a + e.amount, 0))}
                          </button>
                          <button type="button" onClick={() => setFlyout({ week: w, side: 'ap' })} className="rounded-md border border-red-200 bg-red-50 px-2 py-1 font-medium text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
                            {w.apEntries.length} AP outflows · {money(w.apEntries.reduce((a, e) => a + e.amount, 0))}
                          </button>
                          {data.categories.filter((c) => (c.weekly[data.weeks.indexOf(w)] ?? 0) > 0).map((c) => (
                            <span key={c.id} className={cn('rounded-md border px-2 py-1 font-medium', c.direction === 'inflow' ? 'border-teal-200 bg-teal-50 text-teal-700 dark:border-teal-900/50 dark:bg-teal-950/30 dark:text-teal-300' : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300')}>
                              {c.name} · {money(c.weekly[data.weeks.indexOf(w)] ?? 0)}
                            </span>
                          ))}
                          {w.apCapacity !== null ? <span className="rounded-md border border-slate-200 px-2 py-1 text-slate-500 dark:border-slate-700 dark:text-slate-400">AP capacity {money(w.apCapacity)}</span> : null}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </FragmentRows>
              )
            })}
          </tbody>
        </table>
      </Panel>

      {flyout ? <WeekFlyout week={flyout.week} side={flyout.side} onClose={() => setFlyout(null)} onSwitch={(side) => setFlyout({ week: flyout.week, side })} /> : null}
    </>
  )
}

function WeekFlyout({ week, side, onClose, onSwitch }: { week: WeekRow; side: 'ar' | 'ap'; onClose: () => void; onSwitch: (s: 'ar' | 'ap') => void }) {
  const entries = side === 'ar' ? week.arEntries : week.apEntries
  const [entity, setEntity] = useState<{ id: string; name: string } | null>(null)
  const total = entries.reduce((a, e) => a + e.amount, 0)
  const fmtDate = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  return (
    <Drawer
      open
      onClose={onClose}
      size="lg"
      title={week.label}
      description={`${side === 'ar' ? 'Predicted collections' : 'Predicted payments'} · ${money(total)}`}
      bodyClassName="overflow-hidden flex flex-col p-0"
    >
      {/* AR / AP switch */}
      <div className="flex gap-0.5 border-b border-slate-100 px-4 dark:border-slate-800">
        {(['ar', 'ap'] as const).map((s) => (
          <button key={s} type="button" onClick={() => onSwitch(s)} className={cn('-mb-px border-b-2 px-3 py-2.5 text-sm font-medium transition-colors', side === s ? 'border-teal-500 text-teal-600 dark:text-teal-400' : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200')}>
            {s === 'ar' ? `AR Inflows (${week.arEntries.length})` : `AP Outflows (${week.apEntries.length})`}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {entries.length === 0 ? (
          <p className="px-6 py-8 text-center text-sm text-slate-400">No {side === 'ar' ? 'inflows' : 'outflows'} predicted this week.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="px-6 py-2 text-left font-medium">Party</th>
                <th className="px-3 py-2 text-left font-medium">Prediction</th>
                <th className="px-3 py-2 text-right font-medium">Due</th>
                <th className="px-6 py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="group border-b border-slate-50 last:border-0 hover:bg-slate-50/60 dark:border-slate-800/60 dark:hover:bg-slate-800/30">
                  <td className="px-6 py-2.5">
                    <span className="flex items-center gap-1.5">
                      <TxnLink entryId={e.entryId} docKind={e.docKind} docId={e.docId} className="font-medium text-slate-700 group-hover:text-teal-700 dark:text-slate-200 dark:group-hover:text-teal-300">
                        {e.partyName}
                      </TxnLink>
                      {e.partyId ? (
                        <button type="button" onClick={() => setEntity({ id: e.partyId!, name: e.partyName })} title="Payment history & reliability" className="text-slate-300 hover:text-teal-600 dark:text-slate-600 dark:hover:text-teal-400">
                          <History size={12} />
                        </button>
                      ) : null}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="text-xs text-slate-500 dark:text-slate-400">{e.method}</span>
                    {e.daysOverdue > 0 ? <Badge variant="warning" className="ml-1.5 text-[10px]">{e.daysOverdue}d overdue</Badge> : null}
                  </td>
                  <td className="px-3 py-2.5 text-right text-xs tabular-nums text-slate-400 dark:text-slate-500">{e.dueDate ? fmtDate(e.dueDate) : '—'}</td>
                  <td className={cn('px-6 py-2.5 text-right font-medium tabular-nums', side === 'ar' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>{money(e.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {entity ? <EntityDrawer party={entity.id} name={entity.name} side={side} onClose={() => setEntity(null)} /> : null}
    </Drawer>
  )
}

/** Entity payment-history + reliability drill (Gantry getEntityHistory). */
function EntityDrawer({ party, name, side, onClose }: { party: string; name: string; side: 'ar' | 'ap'; onClose: () => void }) {
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let live = true
    fetch(`/api/analytics/cashflow/entity?party=${party}&side=${side}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j) => { if (live) setData(j) })
      .catch(() => { if (live) setError(true) })
    return () => { live = false }
  }, [party, side])
  const fmtDate = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  const relTone = (r: number) => (r >= 80 ? 'text-emerald-600 dark:text-emerald-400' : r >= 60 ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400')

  return (
    <Drawer open onClose={onClose} size="md" title={name} description={side === 'ar' ? 'Customer payment history' : 'Vendor payment history'} bodyClassName="overflow-hidden flex flex-col p-0">
      {error ? (
        <p className="p-6 text-center text-sm text-slate-400">Could not load history.</p>
      ) : !data ? (
        <p className="p-6 text-center text-sm text-slate-400">Loading…</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid grid-cols-2 divide-x divide-slate-100 border-b border-slate-100 dark:divide-slate-800 dark:border-slate-800">
            <div className="px-5 py-3 text-center">
              <p className={cn('text-2xl font-bold tabular-nums', relTone(data.reliability))}>{data.reliability}</p>
              <p className="flex items-center justify-center gap-1 text-[10px] font-medium tracking-wide text-slate-400 uppercase dark:text-slate-500"><GaugeIcon size={10} /> Reliability</p>
            </div>
            <div className="px-5 py-3 text-center">
              <p className="text-2xl font-bold tabular-nums text-slate-800 dark:text-slate-100">{data.avgDays === null ? '—' : `${data.avgDays}d`}</p>
              <p className="text-[10px] font-medium tracking-wide text-slate-400 uppercase dark:text-slate-500">Avg {side === 'ar' ? 'to Collect' : 'to Pay'}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 divide-x divide-slate-100 border-b border-slate-100 dark:divide-slate-800 dark:border-slate-800">
            <div className="px-5 py-3 text-center">
              <p className="text-lg font-semibold tabular-nums text-slate-700 dark:text-slate-200">{money(data.totalPaid)}</p>
              <p className="text-[10px] font-medium tracking-wide text-slate-400 uppercase dark:text-slate-500">{data.paymentCount} payments · 12mo</p>
            </div>
            <div className="px-5 py-3 text-center">
              <p className="text-lg font-semibold tabular-nums text-slate-700 dark:text-slate-200">{money(data.openBalance)}</p>
              <p className="text-[10px] font-medium tracking-wide text-slate-400 uppercase dark:text-slate-500">Open · {data.overdueCount} overdue</p>
            </div>
          </div>
          {data.openItems.length ? (
            <div>
              <p className="px-4 pt-3 text-xs font-semibold tracking-wide text-slate-400 uppercase">Open items ({data.openItems.length})</p>
              <table className="w-full text-sm">
                <tbody>
                  {data.openItems.map((i: any, k: number) => (
                    <tr key={k} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                      <td className="px-4 py-1.5"><TxnLink entryId={i.entryId ?? ''} docKind={i.docKind} docId={i.docId} className="text-slate-700 hover:text-teal-600 dark:text-slate-300 dark:hover:text-teal-400">{i.docNumber || i.docKind}</TxnLink></td>
                      <td className="px-3 py-1.5 text-right text-xs tabular-nums text-slate-400">{i.dueDate ? fmtDate(i.dueDate) : '—'}{i.overdue ? <span className="ml-1 text-red-500">overdue</span> : null}</td>
                      <td className="px-4 py-1.5 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{money(i.remaining)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {data.recentPayments.length ? (
            <div>
              <p className="px-4 pt-3 text-xs font-semibold tracking-wide text-slate-400 uppercase">Recent payments</p>
              <table className="w-full text-sm">
                <tbody>
                  {data.recentPayments.map((p: any, k: number) => (
                    <tr key={k} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                      <td className="px-4 py-1.5 whitespace-nowrap text-xs tabular-nums text-slate-500 dark:text-slate-400">{fmtDate(p.date)}</td>
                      <td className="px-3 py-1.5"><TxnLink entryId={p.entryId ?? ''} docKind={p.docKind} docId={p.docId} className="text-slate-600 hover:text-teal-600 dark:text-slate-300 dark:hover:text-teal-400">{p.docNumber || p.docKind}</TxnLink></td>
                      <td className="px-4 py-1.5 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{money(p.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      )}
    </Drawer>
  )
}

/* --------------------------------------------------------- Category Analysis */
function CategoryTab({ data }: { data: CashflowData }) {
  const [side, setSide] = useState<'ar' | 'ap'>('ap')
  const entries = useMemo(() => {
    const all = data.weeks.flatMap((w) => (side === 'ar' ? w.arEntries : w.apEntries))
    // Group by party.
    const byParty = new Map<string, { name: string; amount: number; count: number }>()
    for (const e of all) {
      const cur = byParty.get(e.partyName) ?? { name: e.partyName, amount: 0, count: 0 }
      cur.amount += e.amount
      cur.count++
      byParty.set(e.partyName, cur)
    }
    return [...byParty.values()].sort((a, b) => b.amount - a.amount)
  }, [data, side])
  const total = entries.reduce((a, e) => a + e.amount, 0)

  return (
    <div className="space-y-4">
      {data.categories.length ? (
        <Panel title="Forecast Categories" icon={SlidersHorizontal} hint="Non-AR/AP flows configured in the Configuration tab" bodyClassName="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="px-4 py-2 text-left font-medium">Category</th>
                <th className="px-4 py-2 text-left font-medium">Method</th>
                <th className="px-4 py-2 text-left font-medium">Forecast Logic</th>
                <th className="px-4 py-2 text-right font-medium">Per Week (avg)</th>
                <th className="px-4 py-2 text-right font-medium">Horizon Total</th>
              </tr>
            </thead>
            <tbody>
              {data.categories.map((c) => (
                <tr key={c.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                  <td className="px-4 py-2.5">
                    <span className={cn('mr-2 inline-block h-2 w-2 rounded-full', c.direction === 'inflow' ? 'bg-emerald-500' : 'bg-red-500')} />
                    <span className="font-medium text-slate-800 dark:text-slate-200">{c.name}</span>
                  </td>
                  <td className="px-4 py-2.5"><span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">{c.method.replace(/_/g, ' ')}</span></td>
                  <td className="px-4 py-2.5 text-xs text-slate-500 dark:text-slate-400">{c.logic || '—'}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-600 dark:text-slate-300">{money(c.total / Math.max(1, c.weekly.length))}</td>
                  <td className={cn('px-4 py-2.5 text-right font-medium tabular-nums', c.direction === 'inflow' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>{money(c.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ) : null}
      <div className="flex items-center justify-between">
        <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 dark:border-slate-700 dark:bg-slate-800/60">
          {(['ap', 'ar'] as const).map((s) => (
            <button key={s} type="button" onClick={() => setSide(s)} className={cn('rounded-md px-3 py-1 text-sm font-medium transition-colors', side === s ? 'bg-white text-teal-600 shadow-sm dark:bg-slate-700 dark:text-teal-300' : 'text-slate-500 dark:text-slate-400')}>
              {s === 'ap' ? 'Outflows (AP)' : 'Inflows (AR)'}
            </button>
          ))}
        </div>
        <span className="text-lg font-bold tabular-nums text-slate-900 dark:text-slate-100">{fmtMoney(total)}</span>
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Predicted {side === 'ap' ? 'payments to vendors' : 'collections from customers'} over the {data.horizonWeeks}-week horizon, grouped by party. Each amount is scheduled into the week its collection/payment date is predicted.
      </p>
      <Panel title={`${side === 'ap' ? 'Payables' : 'Receivables'} by Party`} icon={ListOrdered} bodyClassName="p-0">
        <div className="max-h-[30rem] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white dark:bg-slate-900">
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="px-4 py-2 text-left font-medium">Party</th>
                <th className="px-4 py-2 text-right font-medium">Items</th>
                <th className="px-4 py-2 text-right font-medium">Amount</th>
                <th className="px-4 py-2 text-right font-medium">Share</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.name} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                  <td className="px-4 py-2 text-slate-700 dark:text-slate-300">{e.name}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{e.count}</td>
                  <td className="px-4 py-2 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{money(e.amount)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{total > 0 ? `${((e.amount / total) * 100).toFixed(1)}%` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  )
}

/* ------------------------------------------------------------- Configuration */
function ConfigTab({ data }: { data: CashflowData }) {
  const items: { label: string; value: string; note: string }[] = [
    { label: 'Forecast horizon', value: `${data.horizonWeeks} weeks`, note: 'Weeks of cash projected forward from today' },
    { label: 'As-of date', value: data.asOf, note: 'Anchor for open balances and predictions' },
    { label: 'Prediction method', value: 'Statistical → Due date → Global avg', note: 'Per-party average pay/collect days (+½σ buffer), floored at the due date' },
    { label: 'Overdue push', value: '+7 / +14 / +28 days', note: 'Overdue items pushed forward by how overdue they are (≤30 / ≤60 / >60 days)' },
    { label: 'Business-day snap', value: 'On', note: 'Predicted dates on a weekend move to the next business day' },
    { label: 'Global collect / pay days', value: `${data.summary.dso ?? '—'}d / ${data.summary.dpo ?? '—'}d`, note: 'Fallback averages used when a party has no payment history' },
  ]
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <div className="space-y-5">
        <CategoryManager data={data} />
        <ConfigEditor
          dashboard="cashflow"
          fields={[
            { key: 'weeklyApCap', label: 'Weekly AP cap ($)', help: '0 = unlimited (no scheduling). With a cap, payables are paid oldest-due-first and the rest defers.', min: 0, max: 100_000_000, step: 1000 },
            { key: 'restrictToSafe', label: 'Restrict to safe capacity (0/1)', help: '1 = never pay beyond available cash that week; overflow defers forward', min: 0, max: 1, step: 1 },
          ]}
          values={{ weeklyApCap: data.apSettings.weeklyCap, restrictToSafe: data.apSettings.restrictToSafe ? 1 : 0 }}
          defaults={{ weeklyApCap: 0, restrictToSafe: 0 }}
        />
      </div>
      <div className="space-y-5">
      <Panel title="Forecast Model" icon={SlidersHorizontal} bodyClassName="p-0">
        <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
          {items.map((i) => (
            <li key={i.label} className="flex items-start justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-800 dark:text-slate-200">{i.label}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">{i.note}</p>
              </div>
              <span className="shrink-0 rounded-md bg-slate-100 px-2 py-1 text-right text-sm font-semibold tabular-nums text-slate-700 dark:bg-slate-800 dark:text-slate-200">{i.value}</span>
            </li>
          ))}
        </ul>
      </Panel>
      <Panel title="Bank Accounts" icon={University} bodyClassName="p-0">
        <table className="w-full text-sm">
          <tbody>
            {data.bankAccounts.map((b) => (
              <tr key={b.id} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                <td className="px-4 py-2.5 text-slate-700 dark:text-slate-300">{b.name}{b.number ? <span className="ml-2 text-xs text-slate-400">{b.number}</span> : null}</td>
                <td className={cn('px-4 py-2.5 text-right font-medium tabular-nums', b.balance < 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-800 dark:text-slate-200')}>{fmtMoney(b.balance)}</td>
              </tr>
            ))}
            <tr className="border-t border-slate-200 bg-slate-50/50 dark:border-slate-700 dark:bg-slate-800/30">
              <td className="px-4 py-2.5 font-semibold text-slate-800 dark:text-slate-100">Current Cash</td>
              <td className={cn('px-4 py-2.5 text-right font-bold tabular-nums', data.startingCash < 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-slate-100')}>{fmtMoney(data.startingCash)}</td>
            </tr>
          </tbody>
        </table>
      </Panel>
      </div>
    </div>
  )
}

/**
 * Forecast-category manager — Gantry's category config CRUD, openbooks-style.
 * Edits the full list and PUTs it to /api/analytics/cashflow/categories, then
 * refreshes so the timeline recomputes.
 */
function CategoryManager({ data }: { data: CashflowData }) {
  const router = useRouter()
  const [cats, setCats] = useState<ForecastCategory[]>(() => data.categories.map((c) => ({ id: c.id, name: c.name, direction: c.direction, method: c.method })))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  // Draft for the add form.
  const [name, setName] = useState('')
  const [direction, setDirection] = useState<'inflow' | 'outflow'>('outflow')
  const [method, setMethod] = useState<ForecastCategory['method']>('manual_recurring')
  const [amount, setAmount] = useState('')
  const [frequency, setFrequency] = useState<'weekly' | 'biweekly' | 'monthly'>('monthly')
  const [partyId, setPartyId] = useState('')
  const [accountIds, setAccountIds] = useState<string[]>([])
  const [historyWeeks, setHistoryWeeks] = useState('12')
  const [adjustmentPct, setAdjustmentPct] = useState('0')

  // The server payload carries computed CategoryWeekly rows; the editor needs
  // the raw configs — refetch them once on mount.
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
    else if (method === 'vendor_payment_history') { draft.partyId = partyId; draft.partyName = data.vendorOptions.find((v) => v.id === partyId)?.name }
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
            {data.vendorOptions.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </Select>
        ) : (
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <Select value="" onChange={(e) => { const v = e.target.value; if (v && !accountIds.includes(v)) setAccountIds((a) => [...a, v]) }} className="w-64" triggerClassName="h-7 text-xs">
                <option value="">Add account…</option>
                {data.accountOptions.map((a) => (
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
                  const a = data.accountOptions.find((x) => x.id === id)
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

/* -------------------------------------------------------------- primitives */
function Kpi({ icon: Icon, accent, label, value, sub, tone }: { icon: typeof Wallet; accent: string; label: string; value: string; sub?: string; tone?: 'pos' | 'neg' }) {
  const ACCENT: Record<string, string> = {
    slate: 'bg-slate-100 text-slate-500 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700',
    sky: 'bg-sky-50 text-sky-600 ring-sky-100 dark:bg-sky-950/50 dark:text-sky-300 dark:ring-sky-900/50',
    emerald: 'bg-emerald-50 text-emerald-600 ring-emerald-100 dark:bg-emerald-950/50 dark:text-emerald-300 dark:ring-emerald-900/50',
    red: 'bg-red-50 text-red-600 ring-red-100 dark:bg-red-950/50 dark:text-red-300 dark:ring-red-900/50',
    amber: 'bg-amber-50 text-amber-600 ring-amber-100 dark:bg-amber-950/50 dark:text-amber-300 dark:ring-amber-900/50',
  }
  return (
    <div className="flex items-center gap-3.5 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <span className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-xl ring-1', ACCENT[accent])}><Icon size={20} /></span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[11px] font-semibold tracking-wide text-slate-400 uppercase dark:text-slate-500">{label}</p>
        <p className={cn('truncate text-2xl font-bold tabular-nums', tone === 'neg' ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-slate-100')}>{value}</p>
        {sub ? <p className={cn('truncate text-xs font-medium', tone === 'pos' ? 'text-emerald-600 dark:text-emerald-400' : tone === 'neg' ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400')}>{sub}</p> : null}
      </div>
    </div>
  )
}

function Vital({ icon: Icon, ring, label, value, hint, badge, split, status }: { icon: typeof Flame; ring: string; label: string; value: string; hint: string; badge?: string; split?: boolean; status?: string }) {
  const hintTone = status === 'critical' ? 'text-red-600 dark:text-red-400' : status === 'caution' ? 'text-amber-600 dark:text-amber-400' : status === 'healthy' ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400 dark:text-slate-500'
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center justify-between">
        <span className={cn('grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br text-white', ring)}><Icon size={16} /></span>
        {badge ? <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400">{badge}</span> : null}
      </div>
      <p className="mt-3 text-[11px] font-semibold tracking-wide text-slate-400 uppercase dark:text-slate-500">{label}</p>
      <p className={cn('text-xl font-bold tabular-nums text-slate-900 dark:text-slate-100', split && 'tracking-tight')}>{value}</p>
      <p className={cn('text-[11px]', hintTone)}>{hint}</p>
    </div>
  )
}

function FragmentRows({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

/** Waterfall bridge: Start → +Inflows → −Outflows → Projected End. */
function cashBridgeOption(startCash: number, inflows: number, outflows: number, end: number): Record<string, unknown> {
  const afterIn = startCash + inflows
  const steps = [
    { label: 'Start', from: 0, to: startCash, color: '#94a3b8' },
    { label: 'Inflows', from: startCash, to: afterIn, color: '#10b981' },
    { label: 'Outflows', from: afterIn, to: end, color: '#ef4444' },
    { label: 'Projected End', from: 0, to: end, color: '#0d9488' },
  ]
  const base = steps.map((s) => Math.min(s.from, s.to))
  const bar = steps.map((s) => Math.abs(s.to - s.from))
  const money = (n: number) => {
    const a = Math.abs(n), sign = n < 0 ? '-' : ''
    if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)}M`
    if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(0)}K`
    return `${sign}$${a.toFixed(0)}`
  }
  return {
    grid: { left: 8, right: 12, top: 24, bottom: 8, containLabel: true },
    tooltip: { trigger: 'axis', backgroundColor: 'rgba(15,23,42,0.92)', borderWidth: 0, textStyle: { color: '#f1f5f9', fontSize: 12 }, formatter: (ps: any[]) => `${ps[0]?.axisValue}: ${money([startCash, inflows, -outflows, end][ps[0]?.dataIndex])}` },
    xAxis: { type: 'category', data: steps.map((s) => s.label), axisLine: { lineStyle: { color: 'rgba(148,163,184,0.2)' } }, axisTick: { show: false }, axisLabel: { color: '#94a3b8', fontSize: 10 } },
    yAxis: { type: 'value', axisLine: { show: false }, splitLine: { lineStyle: { color: 'rgba(148,163,184,0.15)' } }, axisLabel: { color: '#94a3b8', fontSize: 10, formatter: (v: number) => money(v) } },
    series: [
      { type: 'bar', stack: 'b', data: base.map(() => ({ value: 0, itemStyle: { color: 'transparent' } })), silent: true },
      { type: 'bar', stack: 'b', data: base.map((b) => ({ value: b, itemStyle: { color: 'transparent' } })), silent: true },
      { type: 'bar', stack: 'b', data: bar.map((v, i) => ({ value: v, itemStyle: { color: steps[i].color, borderRadius: 3 } })), barMaxWidth: 46, label: { show: true, position: 'top', color: '#94a3b8', fontSize: 9, formatter: (p: any) => money([startCash, inflows, -outflows, end][p.dataIndex]) } },
    ],
  }
}
