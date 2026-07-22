'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Drawer, cn } from '@openbooks/ui'
import {
  History,
  Gauge as GaugeIcon,
  Search,
  ArrowDown,
  ArrowUp,
  ArrowLeftRight,
  ArrowRight,
  Wallet,
  ShieldCheck,
  Clock,
  Landmark,
  ChevronLeft,
  ChevronRight,
  ArrowUpDown,
  Cog,
  List,
  Download,
} from 'lucide-react'
import type { CategoryWeekly, ForecastEntry, WeekRow } from '../../../../lib/cash/core'
import { TxnLink } from '../../reports/TxnLink'
import { Gauge } from './Gauge'
import { EntityDrawer } from './EntityDrawer'
import { useAnalyticsMoney } from './format'
const fmtDate = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const PAGE_SIZE = 25

type SortCol = 'docNumber' | 'partyName' | 'predictedDate' | 'amount'
type TabKey = 'ar' | 'ap' | `cat:${string}`

/** Gantry's method → accent colors for the category method pill. */
const CAT_METHOD_TONE: Record<string, string> = {
  'GL Average': 'text-sky-600 dark:text-sky-400',
  'Vendor History (Median)': 'text-violet-600 dark:text-violet-400',
  'Credit Card Cycle': 'text-pink-600 dark:text-pink-400',
  'Manual Recurring': 'text-emerald-600 dark:text-emerald-400',
  'Vendor Recurring (Auto)': 'text-amber-600 dark:text-amber-400',
  'Bank Register History': 'text-cyan-600 dark:text-cyan-400',
  'Calculated Formula': 'text-indigo-600 dark:text-indigo-400',
}

/** Human labels for the meta stats behind each estimate. */
const META_LABELS: Record<string, string> = {
  sourceTotal: 'Source total', weeksUsed: 'Weeks used', rawAverage: 'Raw avg', adjustmentPct: 'Adjustment %',
  finalAverage: 'Weekly avg', monthlyMedian: 'Monthly median', finalWeekly: 'Weekly est', vendors: 'Vendors',
  vendor: 'Vendor', amount: 'Amount', frequency: 'Frequency', detectedPaymentDay: 'Pays on day',
  medianPayment: 'Median payment', avgPayment: 'Avg payment', currentBalance: 'Card balance',
  daysSinceLastPayment: 'Days since paid', dailyBurnRate: 'Daily burn', monthlySpendRate: 'Monthly spend',
  paymentTrend: 'Trend', monthsAnalyzed: 'Months analyzed', accountsIncluded: 'Accounts',
  nextPaymentDate: 'Next payment', projectedGrowth: 'Projected growth', samples: 'Samples',
  interval: 'Interval (days)', avgAmount: 'Avg amount', bankAccounts: 'Bank accounts',
  historyWeeks: 'History weeks', currentWeekApplied: 'Applied this week', memoKeywords: 'Memo filter',
}
const MONEYISH = new Set(['sourceTotal','rawAverage','finalAverage','monthlyMedian','finalWeekly','amount','medianPayment','avgPayment','currentBalance','dailyBurnRate','monthlySpendRate','projectedGrowth','avgAmount','currentWeekApplied'])

/**
 * Per-week cash drill at the legacy Gantry dashboard's full fidelity: KPI
 * cards (net change + coverage gauge), the week's complete flow breakdown,
 * then the primary tabs — AR Inflows and AP Outflows with counts AND totals,
 * plus one tab per forecast CATEGORY active that week (Gantry's Category
 * Analysis: method KPIs, source-item table with search / sort / pagination /
 * CSV export). Transaction tabs carry the search toolbar, sortable table with
 * document-ID drill, method + days pills, pagination, and the run-builder
 * handoff. Shared by the Cash cockpit and the AP/AR drills.
 */
export function CashWeekFlyout({
  week,
  categories = [],
  weekIndex = 0,
  initialSide = 'ap',
  canPayRun = false,
  canCollectionRun = false,
  onClose,
}: {
  week: WeekRow
  /** Full forecast categories (weekly aligned with the horizon grid). */
  categories?: CategoryWeekly[]
  /** This week's index into each category's weekly[] array. */
  weekIndex?: number
  initialSide?: 'ar' | 'ap'
  /** ap.pay — shows "Build pay run" on the AP tab (filtered set → /payments). */
  canPayRun?: boolean
  /** ar.pay — shows "Build collection run" on the AR tab (filtered set → /receipts). */
  canCollectionRun?: boolean
  onClose: () => void
}) {
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const router = useRouter()
  const [tab, setTab] = useState<TabKey>(initialSide)
  const [entity, setEntity] = useState<{ id: string; name: string } | null>(null)
  const [search, setSearch] = useState('')
  const [sortCol, setSortCol] = useState<SortCol>('amount')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(1)

  const arTotal = week.arEntries.reduce((a, e) => a + e.amount, 0)
  const apTotal = week.apEntries.reduce((a, e) => a + e.amount, 0)
  const weekCats = categories.filter((c) => (c.weekly[weekIndex] ?? 0) > 0)
  const otherIn = weekCats.filter((c) => c.direction === 'inflow').reduce((a, c) => a + (c.weekly[weekIndex] ?? 0), 0)
  const catOuts = weekCats.filter((c) => c.direction === 'outflow')
  const coverage = week.outflow > 0 ? week.inflow / week.outflow : 1

  // Breakdown — the legacy summary rows, straight off the shared WeekRow.
  const breakdown: { label: string; value: number; icon: typeof Wallet; tone: string }[] = [
    { label: 'Starting Cash', value: week.startingCash, icon: Wallet, tone: 'neutral' },
    ...(week.apCapacity !== null ? [{ label: 'Safe AP Capacity', value: week.apCapacity, icon: ShieldCheck, tone: 'info' }] : []),
    { label: 'Inflow (AR)', value: arTotal, icon: ArrowDown, tone: 'inflow' },
    ...(otherIn > 0 ? [{ label: 'Inflow (Other)', value: otherIn, icon: ArrowDown, tone: 'inflow' }] : []),
    { label: 'Outflow (AP)', value: apTotal, icon: ArrowUp, tone: 'outflow' },
    ...catOuts.map((c) => ({ label: `Out: ${c.name}`, value: c.weekly[weekIndex] ?? 0, icon: ArrowUp, tone: 'outflow' })),
    ...(week.deferredOut > 0 ? [{ label: 'Deferred (Backlog)', value: week.deferredOut, icon: Clock, tone: 'warning' }] : []),
    { label: 'Net Change', value: week.net, icon: ArrowLeftRight, tone: week.net >= 0 ? 'positive' : 'negative' },
    { label: 'Ending Cash', value: week.endingCash, icon: Landmark, tone: week.endingCash >= 0 ? 'neutral' : 'negative' },
  ]

  const side: 'ar' | 'ap' = tab === 'ar' ? 'ar' : 'ap'
  const activeCat = tab.startsWith('cat:') ? weekCats.find((c) => c.id === tab.slice(4)) : undefined
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

  const switchTab = (k: TabKey) => {
    setTab(k)
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
            <Gauge value={Math.min(100, coverage * 100)} size={64} thickness={8} showTicks={false} showValue={false} className="shrink-0" />
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

      {/* primary tabs: AR / AP / each category active this week */}
      <div className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-slate-100 px-4 dark:border-slate-800">
        {(
          [
            { key: 'ar' as TabKey, label: 'AR Inflows', icon: <ArrowDown size={13} className="text-emerald-500" />, count: week.arEntries.length, total: arTotal, badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300' },
            { key: 'ap' as TabKey, label: 'AP Outflows', icon: <ArrowUp size={13} className="text-red-500" />, count: week.apEntries.length, total: apTotal, badge: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300' },
          ]
        ).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => switchTab(t.key)}
            className={cn('-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors', tab === t.key ? 'border-teal-500 text-teal-600 dark:text-teal-400' : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200')}
          >
            {t.icon}
            {t.label}
            <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-bold', t.badge)}>{t.count}</span>
            <span className="rounded-full border border-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 dark:border-slate-700 dark:text-slate-400">{money(t.total)}</span>
          </button>
        ))}
        {weekCats.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => switchTab(`cat:${c.id}`)}
            className={cn('-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors', tab === `cat:${c.id}` ? 'border-teal-500 text-teal-600 dark:text-teal-400' : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200')}
          >
            <Cog size={13} className={c.direction === 'inflow' ? 'text-teal-500' : 'text-amber-500'} />
            {c.name}
            <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-semibold', c.direction === 'inflow' ? 'bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300')}>{money(c.weekly[weekIndex] ?? 0)}</span>
          </button>
        ))}
      </div>

      {activeCat ? (
        <CategoryPane key={activeCat.id} cat={activeCat} weekAmount={activeCat.weekly[weekIndex] ?? 0} />
      ) : (
        <>
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

          {/* action bar — hand the filtered set to the run builders */}
          {(side === 'ap' && canPayRun) || (side === 'ar' && canCollectionRun) ? (
            <ActionBar side={side} entries={filtered} onBuild={(ids) => {
              const base = side === 'ap' ? '/payments' : '/receipts'
              router.push(`${base}?view=runs&newRun=1&preselect=${ids.join(',')}` as any)
            }} />
          ) : null}
        </>
      )}

      {entity ? <EntityDrawer party={entity.id} name={entity.name} side={side} onClose={() => setEntity(null)} /> : null}
    </Drawer>
  )
}

/**
 * Gantry's Category Analysis pane, scoped to the week flyout: method KPI row
 * (This Week / Total Forecast / Method / Source Items / Export CSV), the
 * forecast-logic line, and the source-item table with search, sortable
 * columns and pagination.
 */
function CategoryPane({ cat, weekAmount }: { cat: CategoryWeekly; weekAmount: number }) {
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const [search, setSearch] = useState('')
  const [sortCol, setSortCol] = useState<'name' | 'date' | 'amount' | 'type'>('amount')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(1)

  const tone = cat.direction === 'inflow' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
  const methodTone = CAT_METHOD_TONE[cat.meta.method] ?? 'text-slate-600 dark:text-slate-300'

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return cat.breakdown
    return cat.breakdown.filter((r) =>
      r.name.toLowerCase().includes(q) || r.type.toLowerCase().includes(q) || (r.date ?? '').toLowerCase().includes(q))
  }, [cat.breakdown, search])

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    return filtered.slice().sort((a, b) => {
      const av = sortCol === 'amount' ? Math.abs(a.amount) : ((a[sortCol] ?? '') as string).toLowerCase()
      const bv = sortCol === 'amount' ? Math.abs(b.amount) : ((b[sortCol] ?? '') as string).toLowerCase()
      return av < bv ? -dir : av > bv ? dir : 0
    })
  }, [filtered, sortCol, sortDir])

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const curPage = Math.min(page, totalPages)
  const start = (curPage - 1) * PAGE_SIZE
  const paged = sorted.slice(start, start + PAGE_SIZE)

  const sortBy = (col: typeof sortCol) => {
    if (sortCol === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortCol(col)
      setSortDir(col === 'amount' ? 'desc' : 'asc')
    }
  }
  const sortIcon = (col: typeof sortCol) => (
    <ArrowUpDown size={10} className={cn('ml-1 inline', sortCol === col ? 'text-teal-500' : 'text-slate-300 dark:text-slate-600')} />
  )

  // Gantry exportCategoryCSV, client-side.
  const exportCsv = () => {
    let csv = `"Category","${cat.name.replace(/"/g, '""')}"\n"Total","${cat.total}"\n\n"Entity/Description","Date","Amount","Type"\n`
    for (const row of cat.breakdown) {
      csv += `"${row.name.replace(/"/g, '""')}","${row.date ?? ''}","${row.amount}","${row.type}"\n`
    }
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `cashflow_category_${cat.name.replace(/\s+/g, '_')}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const kpis: { label: string; value: string; cls?: string }[] = [
    { label: 'This Week', value: money(weekAmount), cls: tone },
    { label: 'Total Forecast', value: money(cat.total), cls: tone },
    { label: 'Method', value: cat.meta.method, cls: methodTone },
    { label: 'Source Items', value: String(cat.breakdown.length) },
  ]

  return (
    <>
      {/* KPI row + export */}
      <div className="flex shrink-0 items-stretch gap-2 border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
        {kpis.map((k) => (
          <div key={k.label} className="flex-1 rounded-lg border border-slate-200 px-3 py-1.5 dark:border-slate-800">
            <p className="text-[10px] font-semibold tracking-wide text-slate-400 uppercase dark:text-slate-500">{k.label}</p>
            <p className={cn('truncate text-sm font-bold tabular-nums', k.cls ?? 'text-slate-800 dark:text-slate-100')}>{k.value}</p>
          </div>
        ))}
        <button type="button" onClick={exportCsv} title="Export CSV" className="flex shrink-0 items-center gap-1.5 self-center rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
          <Download size={13} />
          Export
        </button>
      </div>
      <p className="flex shrink-0 items-center gap-1.5 border-b border-slate-100 px-4 py-1.5 text-[11px] text-slate-500 dark:border-slate-800 dark:text-slate-400">
        <List size={11} />
        {cat.logic || '—'}
      </p>
      {Object.keys(cat.meta).filter((k) => k !== 'method' && k !== 'formula').length ? (
        <div className="flex shrink-0 flex-wrap gap-1.5 border-b border-slate-100 px-4 py-2 dark:border-slate-800">
          {Object.entries(cat.meta)
            .filter(([k]) => k !== 'method' && k !== 'formula')
            .map(([k, v]) => (
              <span key={k} className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                {META_LABELS[k] ?? k}: <span className="font-semibold tabular-nums">{typeof v === 'number' && MONEYISH.has(k) ? money(v) : String(v)}</span>
              </span>
            ))}
        </div>
      ) : null}

      {/* search */}
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-100 px-4 py-2 dark:border-slate-800">
        <div className="relative flex-1">
          <Search size={13} className="absolute top-1/2 left-2.5 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1) }}
            placeholder="Search source items…"
            className="h-8 w-full rounded-md border border-slate-200 bg-white pr-2 pl-8 text-sm text-slate-700 placeholder:text-slate-400 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
          />
        </div>
      </div>

      {/* source-item table */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {paged.length === 0 ? (
          <p className="px-6 py-10 text-center text-sm text-slate-400">
            {search ? 'No matches for your search.' : 'No source items behind this estimate.'}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="cursor-pointer px-4 py-2 text-left font-medium select-none" onClick={() => sortBy('name')}>Entity / Description{sortIcon('name')}</th>
                <th className="cursor-pointer px-3 py-2 text-left font-medium select-none" onClick={() => sortBy('date')}>Date{sortIcon('date')}</th>
                <th className="cursor-pointer px-3 py-2 text-center font-medium select-none" onClick={() => sortBy('type')}>Type{sortIcon('type')}</th>
                <th className="cursor-pointer px-4 py-2 text-right font-medium select-none" onClick={() => sortBy('amount')}>Amount{sortIcon('amount')}</th>
              </tr>
            </thead>
            <tbody>
              {paged.map((r, i) => (
                <tr key={`${r.name}-${r.date ?? ''}-${i}`} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60 dark:border-slate-800/60 dark:hover:bg-slate-800/30">
                  <td className="px-4 py-2.5">
                    <span className="font-medium text-slate-700 dark:text-slate-200">{r.name}</span>
                    {r.details ? <span className="block text-[11px] text-slate-400 dark:text-slate-500">{r.details}</span> : null}
                  </td>
                  <td className="px-3 py-2.5 text-xs tabular-nums text-slate-500 dark:text-slate-400">{r.date ? fmtDate(r.date) : '—'}</td>
                  <td className="px-3 py-2.5 text-center">
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">{r.type}</span>
                  </td>
                  <td className={cn('px-4 py-2.5 text-right font-semibold tabular-nums', tone)}>{money(r.amount)}</td>
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
    </>
  )
}

/**
 * Run-builder handoff for the week's flow: AP tab → payment run, AR tab →
 * collection run. Acts on the FILTERED set (search narrows the run), routed
 * through the shared ?preselect= wiring so the run builder opens with these
 * documents pre-checked.
 */
function ActionBar({
  side,
  entries,
  onBuild,
}: {
  side: 'ar' | 'ap'
  entries: ForecastEntry[]
  onBuild: (docIds: string[]) => void
}) {
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const runnable = entries.filter((e) => e.docId)
  const total = runnable.reduce((a, e) => a + e.amount, 0)
  if (runnable.length === 0) return null
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-t border-slate-200 bg-slate-50/60 px-4 py-2.5 dark:border-slate-800 dark:bg-slate-800/30">
      <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
        {runnable.length} {side === 'ap' ? 'bills' : 'invoices'} · {money(total)}
      </span>
      <Button size="sm" onClick={() => onBuild(runnable.map((e) => e.docId!))}>
        {side === 'ap' ? 'Build pay run' : 'Build collection run'}
        <ArrowRight size={15} />
      </Button>
    </div>
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
