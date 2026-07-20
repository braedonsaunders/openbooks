'use client'

import { useEffect, useMemo, useState } from 'react'
import { Badge, Drawer, cn } from '@openbooks/ui'
import {
  History,
  Gauge as GaugeIcon,
  Search,
  ArrowDown,
  ArrowUp,
  ArrowLeftRight,
  Wallet,
  ShieldCheck,
  Clock,
  Landmark,
  ChevronLeft,
  ChevronRight,
  ArrowUpDown,
} from 'lucide-react'
import type { ForecastEntry, WeekRow } from '../../../../lib/cash/core'
import { TxnLink } from '../../reports/TxnLink'
import { Gauge } from './Gauge'
import { fmtMoney } from './format'

const money = (n: number) => fmtMoney(n, { compact: true })
const fmtDate = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const PAGE_SIZE = 25

export interface CategoryFlow {
  name: string
  direction: 'inflow' | 'outflow'
  amount: number
}

type SortCol = 'docNumber' | 'partyName' | 'predictedDate' | 'amount'

/**
 * Per-week cash drill at the legacy Gantry dashboard's full fidelity: KPI
 * cards (net change + coverage gauge), the week's complete flow breakdown
 * (starting cash → safe capacity → AR/other in → AP/category out → deferred →
 * ending), AR/AP tabs with counts AND totals, a search toolbar, a sortable
 * transaction table (ID drill, entity drill, prediction-method and days
 * pills), and pagination. Shared by the Cash cockpit and the AP/AR drills.
 */
export function CashWeekFlyout({
  week,
  categoryFlows = [],
  initialSide = 'ap',
  onClose,
}: {
  week: WeekRow
  categoryFlows?: CategoryFlow[]
  initialSide?: 'ar' | 'ap'
  onClose: () => void
}) {
  const [side, setSide] = useState<'ar' | 'ap'>(initialSide)
  const [entity, setEntity] = useState<{ id: string; name: string } | null>(null)
  const [search, setSearch] = useState('')
  const [sortCol, setSortCol] = useState<SortCol>('amount')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(1)

  const arTotal = week.arEntries.reduce((a, e) => a + e.amount, 0)
  const apTotal = week.apEntries.reduce((a, e) => a + e.amount, 0)
  const otherIn = categoryFlows.filter((c) => c.direction === 'inflow').reduce((a, c) => a + c.amount, 0)
  const catOuts = categoryFlows.filter((c) => c.direction === 'outflow')
  const coverage = week.outflow > 0 ? week.inflow / week.outflow : 1

  // Breakdown — the legacy summary rows, straight off the shared WeekRow.
  const breakdown: { label: string; value: number; icon: typeof Wallet; tone: string }[] = [
    { label: 'Starting Cash', value: week.startingCash, icon: Wallet, tone: 'neutral' },
    ...(week.apCapacity !== null ? [{ label: 'Safe AP Capacity', value: week.apCapacity, icon: ShieldCheck, tone: 'info' }] : []),
    { label: 'Inflow (AR)', value: arTotal, icon: ArrowDown, tone: 'inflow' },
    ...(otherIn > 0 ? [{ label: 'Inflow (Other)', value: otherIn, icon: ArrowDown, tone: 'inflow' }] : []),
    { label: 'Outflow (AP)', value: apTotal, icon: ArrowUp, tone: 'outflow' },
    ...catOuts.map((c) => ({ label: `Out: ${c.name}`, value: c.amount, icon: ArrowUp, tone: 'outflow' })),
    ...(week.deferredOut > 0 ? [{ label: 'Deferred (Backlog)', value: week.deferredOut, icon: Clock, tone: 'warning' }] : []),
    { label: 'Net Change', value: week.net, icon: ArrowLeftRight, tone: week.net >= 0 ? 'positive' : 'negative' },
    { label: 'Ending Cash', value: week.endingCash, icon: Landmark, tone: week.endingCash >= 0 ? 'neutral' : 'negative' },
  ]

  const entries = side === 'ar' ? week.arEntries : week.apEntries
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return entries
    return entries.filter((e) => e.partyName.toLowerCase().includes(q) || (e.docNumber ?? '').toLowerCase().includes(q))
  }, [entries, search])

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    return filtered.slice().sort((a, b) => {
      const av = sortCol === 'amount' ? a.amount : ((a[sortCol] ?? '') as string)
      const bv = sortCol === 'amount' ? b.amount : ((b[sortCol] ?? '') as string)
      return av < bv ? -dir : av > bv ? dir : 0
    })
  }, [filtered, sortCol, sortDir])

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const curPage = Math.min(page, totalPages)
  const start = (curPage - 1) * PAGE_SIZE
  const paged = sorted.slice(start, start + PAGE_SIZE)

  const switchSide = (s: 'ar' | 'ap') => {
    setSide(s)
    setSearch('')
    setPage(1)
  }
  const sortBy = (col: SortCol) => {
    if (sortCol === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortCol(col)
      setSortDir('desc')
    }
  }

  const TONE: Record<string, { label: string; value: string }> = {
    neutral: { label: 'text-slate-500 dark:text-slate-400', value: 'text-slate-800 dark:text-slate-200' },
    info: { label: 'text-sky-600 dark:text-sky-400', value: 'text-sky-600 dark:text-sky-400' },
    inflow: { label: 'text-emerald-600 dark:text-emerald-400', value: 'text-emerald-600 dark:text-emerald-400' },
    outflow: { label: 'text-red-600 dark:text-red-400', value: 'text-red-600 dark:text-red-400' },
    warning: { label: 'text-amber-600 dark:text-amber-400', value: 'text-amber-600 dark:text-amber-400' },
    positive: { label: 'text-slate-500 dark:text-slate-400', value: 'text-emerald-600 dark:text-emerald-400' },
    negative: { label: 'text-slate-500 dark:text-slate-400', value: 'text-red-600 dark:text-red-400' },
  }

  const sortIcon = (col: SortCol) => (
    <ArrowUpDown size={10} className={cn('ml-1 inline', sortCol === col ? 'text-teal-500' : 'text-slate-300 dark:text-slate-600')} />
  )

  return (
    <Drawer
      open
      onClose={onClose}
      size="xl"
      title={week.label}
      description={`Net ${week.net >= 0 ? '+' : ''}${money(week.net)} · ending ${money(week.endingCash)}`}
      bodyClassName="overflow-hidden flex flex-col p-0"
    >
      {/* KPI cards + breakdown */}
      <div className="shrink-0 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <div className="mb-3 flex items-stretch gap-3">
          <div className="flex flex-1 items-center gap-3 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
            <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg', week.net >= 0 ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-400' : 'bg-red-50 text-red-600 dark:bg-red-950/50 dark:text-red-400')}>
              <ArrowLeftRight size={16} />
            </span>
            <div>
              <p className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase dark:text-slate-500">Net Change</p>
              <p className={cn('text-lg font-bold tabular-nums', week.net >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
                {week.net >= 0 ? '+' : ''}{money(week.net)}
              </p>
            </div>
          </div>
          <div className="flex flex-1 items-center gap-3 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
            <Gauge value={Math.min(100, coverage * 100)} size={72} thickness={8} showTicks={false} />
            <div>
              <p className="flex items-center gap-1 text-[10px] font-semibold tracking-wide text-slate-400 uppercase dark:text-slate-500"><GaugeIcon size={10} /> Coverage Ratio</p>
              <p className="text-lg font-bold tabular-nums text-slate-800 dark:text-slate-100">{(coverage * 100).toFixed(0)}%</p>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
          {breakdown.map((row) => {
            const tone = TONE[row.tone]!
            const Icon = row.icon
            return (
              <div key={row.label} className="flex items-center justify-between border-b border-slate-50 py-1 text-xs last:border-0 sm:[&:nth-last-child(2)]:border-0 dark:border-slate-800/60">
                <span className={cn('flex items-center gap-1.5', tone.label)}><Icon size={11} />{row.label}</span>
                <span className={cn('font-semibold tabular-nums', tone.value)}>{money(row.value)}</span>
              </div>
            )
          })}
        </div>
      </div>

      {/* AR / AP tabs with counts + totals */}
      <div className="flex shrink-0 gap-0.5 border-b border-slate-100 px-4 dark:border-slate-800">
        {(
          [
            { key: 'ar' as const, label: 'AR Inflows', count: week.arEntries.length, total: arTotal, badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300' },
            { key: 'ap' as const, label: 'AP Outflows', count: week.apEntries.length, total: apTotal, badge: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300' },
          ]
        ).map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => switchSide(tab.key)}
            className={cn('-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors', side === tab.key ? 'border-teal-500 text-teal-600 dark:text-teal-400' : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200')}
          >
            {tab.key === 'ar' ? <ArrowDown size={13} className="text-emerald-500" /> : <ArrowUp size={13} className="text-red-500" />}
            {tab.label}
            <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-bold', tab.badge)}>{tab.count}</span>
            <span className="rounded-full border border-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 dark:border-slate-700 dark:text-slate-400">{money(tab.total)}</span>
          </button>
        ))}
      </div>

      {/* search toolbar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-100 px-4 py-2 dark:border-slate-800">
        <div className="relative flex-1">
          <Search size={13} className="absolute top-1/2 left-2.5 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1) }}
            placeholder={`Search ${side === 'ar' ? 'customers' : 'vendors'} or document #…`}
            className="h-8 w-full rounded-md border border-slate-200 bg-white pr-2 pl-8 text-sm text-slate-700 placeholder:text-slate-400 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
          />
        </div>
      </div>

      {/* transaction table */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {paged.length === 0 ? (
          <p className="px-6 py-10 text-center text-sm text-slate-400">
            {search ? 'No matches for your search.' : `No ${side === 'ar' ? 'inflows' : 'outflows'} predicted this week.`}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="cursor-pointer px-4 py-2 text-left font-medium select-none" onClick={() => sortBy('docNumber')}>ID{sortIcon('docNumber')}</th>
                <th className="cursor-pointer px-3 py-2 text-left font-medium select-none" onClick={() => sortBy('partyName')}>{side === 'ar' ? 'Customer' : 'Vendor'}{sortIcon('partyName')}</th>
                <th className="cursor-pointer px-3 py-2 text-left font-medium select-none" onClick={() => sortBy('predictedDate')}>Predicted{sortIcon('predictedDate')}</th>
                <th className="px-3 py-2 text-center font-medium">Method</th>
                <th className="px-3 py-2 text-center font-medium">Status</th>
                <th className="cursor-pointer px-4 py-2 text-right font-medium select-none" onClick={() => sortBy('amount')}>Amount{sortIcon('amount')}</th>
              </tr>
            </thead>
            <tbody>
              {paged.map((e) => (
                <tr key={e.id} className="group border-b border-slate-50 last:border-0 hover:bg-slate-50/60 dark:border-slate-800/60 dark:hover:bg-slate-800/30">
                  <td className="px-4 py-2.5">
                    <TxnLink entryId={e.entryId} docKind={e.docKind} docId={e.docId} className="font-mono text-[13px] font-semibold text-teal-700 hover:underline dark:text-teal-300">
                      {e.docNumber || e.docKind || '—'}
                    </TxnLink>
                  </td>
                  <td className="px-3 py-2.5">
                    {e.partyId ? (
                      <button type="button" onClick={() => setEntity({ id: e.partyId!, name: e.partyName })} title="Payment history & reliability" className="flex items-center gap-1 font-medium text-slate-700 hover:text-teal-700 dark:text-slate-200 dark:hover:text-teal-300">
                        {e.partyName}
                        <History size={11} className="text-slate-300 group-hover:text-teal-500 dark:text-slate-600" />
                      </button>
                    ) : (
                      <span className="font-medium text-slate-700 dark:text-slate-200">{e.partyName}</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-xs tabular-nums text-slate-500 dark:text-slate-400">{fmtDate(e.predictedDate)}</td>
                  <td className="px-3 py-2.5 text-center"><MethodPill method={e.method} /></td>
                  <td className="px-3 py-2.5 text-center"><DaysPill entry={e} /></td>
                  <td className={cn('px-4 py-2.5 text-right font-semibold tabular-nums', side === 'ar' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>{money(e.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* pagination */}
      {sorted.length > PAGE_SIZE ? (
        <div className="flex shrink-0 items-center justify-between border-t border-slate-100 px-4 py-2 dark:border-slate-800">
          <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
            Showing {start + 1}–{Math.min(start + PAGE_SIZE, sorted.length)} of {sorted.length}
          </span>
          <div className="flex items-center gap-1">
            <button type="button" disabled={curPage <= 1} onClick={() => setPage((p) => p - 1)} className="rounded-md border border-slate-200 p-1 text-slate-500 disabled:opacity-40 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
              <ChevronLeft size={14} />
            </button>
            <span className="px-1 text-xs font-medium tabular-nums text-slate-500 dark:text-slate-400">{curPage}/{totalPages}</span>
            <button type="button" disabled={curPage >= totalPages} onClick={() => setPage((p) => p + 1)} className="rounded-md border border-slate-200 p-1 text-slate-500 disabled:opacity-40 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      ) : null}

      {entity ? <EntityDrawer party={entity.id} name={entity.name} side={side} onClose={() => setEntity(null)} /> : null}
    </Drawer>
  )
}

/** Prediction-method pill (legacy classes: History / Terms / Average / Pushed). */
function MethodPill({ method }: { method: string }) {
  const base = method.replace(/\s*\(deferred.*$/, '')
  const map: Record<string, { label: string; cls: string }> = {
    Statistical: { label: 'History', cls: 'bg-violet-50 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300' },
    'Due date': { label: 'Due Date', cls: 'bg-sky-50 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300' },
    'Global avg': { label: 'Average', cls: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' },
    'Overdue push': { label: 'Pushed', cls: 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300' },
  }
  const m = map[base] ?? { label: base, cls: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' }
  return (
    <span title={method} className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap', m.cls)}>
      {m.label}
    </span>
  )
}

/** Days-vs-due pill: overdue red (+Nd), due within a week amber, comfortable green. */
function DaysPill({ entry }: { entry: ForecastEntry }) {
  if (!entry.dueDate) return <span className="text-xs text-slate-300 dark:text-slate-600">—</span>
  const days = Math.round((Date.now() - new Date(entry.dueDate + 'T00:00:00Z').getTime()) / 86_400_000)
  const cls = days > 0
    ? 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300'
    : days >= -7
      ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300'
      : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
  return <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums whitespace-nowrap', cls)}>{days > 0 ? `+${days}d` : `${days}d`}</span>
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
  const dt = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
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
          {data.openItems?.length ? (
            <div>
              <p className="px-4 pt-3 text-xs font-semibold tracking-wide text-slate-400 uppercase">Open items ({data.openItems.length})</p>
              <table className="w-full text-sm">
                <tbody>
                  {data.openItems.map((i: any, k: number) => (
                    <tr key={k} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                      <td className="px-4 py-1.5"><TxnLink entryId={i.entryId ?? ''} docKind={i.docKind} docId={i.docId} className="text-slate-700 hover:text-teal-600 dark:text-slate-300 dark:hover:text-teal-400">{i.docNumber || i.docKind}</TxnLink></td>
                      <td className="px-3 py-1.5 text-right text-xs tabular-nums text-slate-400">{i.dueDate ? dt(i.dueDate) : '—'}{i.overdue ? <span className="ml-1 text-red-500">overdue</span> : null}</td>
                      <td className="px-4 py-1.5 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{money(i.remaining)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {data.recentPayments?.length ? (
            <div>
              <p className="px-4 pt-3 text-xs font-semibold tracking-wide text-slate-400 uppercase">Recent payments</p>
              <table className="w-full text-sm">
                <tbody>
                  {data.recentPayments.map((p: any, k: number) => (
                    <tr key={k} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                      <td className="px-4 py-1.5 whitespace-nowrap text-xs tabular-nums text-slate-500 dark:text-slate-400">{dt(p.date)}</td>
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
