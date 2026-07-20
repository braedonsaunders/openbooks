'use client'

import { useEffect, useState } from 'react'
import { Badge, Drawer, cn } from '@openbooks/ui'
import { History, Gauge as GaugeIcon } from 'lucide-react'
import type { WeekRow } from '../../../../lib/cash/core'
import { TxnLink } from '../../reports/TxnLink'
import { fmtMoney } from './format'

const money = (n: number) => fmtMoney(n, { compact: true })
const fmtDate = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

export interface CategoryFlow {
  name: string
  direction: 'inflow' | 'outflow'
  amount: number
}

/**
 * Per-week cash drill — what flows in (predicted collections + inflow
 * categories) and out (predicted payments + outflow categories) for one week,
 * each line drilling to its native record. Shared by the analytics forecast
 * and the Banking cash cockpit. Manages its own AR/AP tab.
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

  const entries = side === 'ar' ? week.arEntries : week.apEntries
  const cats = categoryFlows.filter((c) => (side === 'ar' ? c.direction === 'inflow' : c.direction === 'outflow'))
  const entriesTotal = entries.reduce((a, e) => a + e.amount, 0)
  const catsTotal = cats.reduce((a, c) => a + c.amount, 0)
  const total = entriesTotal + catsTotal

  return (
    <Drawer
      open
      onClose={onClose}
      size="lg"
      title={week.label}
      description={`${side === 'ar' ? 'Cash in' : 'Cash out'} · ${money(total)}`}
      bodyClassName="overflow-hidden flex flex-col p-0"
    >
      {/* in / out switch */}
      <div className="flex gap-0.5 border-b border-slate-100 px-4 dark:border-slate-800">
        {(['ap', 'ar'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSide(s)}
            className={cn('-mb-px border-b-2 px-3 py-2.5 text-sm font-medium transition-colors', side === s ? 'border-teal-500 text-teal-600 dark:text-teal-400' : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200')}
          >
            {s === 'ar' ? `Cash in (${week.arEntries.length})` : `Cash out (${week.apEntries.length})`}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {entries.length === 0 && cats.length === 0 ? (
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
              {cats.map((c) => (
                <tr key={`cat-${c.name}`} className="border-b border-slate-50 bg-slate-50/40 last:border-0 dark:border-slate-800/60 dark:bg-slate-800/20">
                  <td className="px-6 py-2.5">
                    <span className="font-medium text-slate-600 dark:text-slate-300">{c.name}</span>
                    <Badge variant="outline" className="ml-1.5 text-[10px]">forecast</Badge>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-slate-400 dark:text-slate-500">Recurring category</td>
                  <td className="px-3 py-2.5" />
                  <td className={cn('px-6 py-2.5 text-right font-medium tabular-nums', side === 'ar' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>{money(c.amount)}</td>
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
