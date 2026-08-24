'use client'

import { useEffect, useState } from 'react'
import { Drawer, cn } from '@openbooks/ui'
import { Gauge as GaugeIcon, ChevronLeft, ChevronRight } from 'lucide-react'
import { TxnLink } from '../../reports/TxnLink'
import { useAnalyticsMoney } from './format'
const PER_PAGE = 25

/**
 * Party reliability drawer — the cash-flyout entity drill promoted to a
 * shared component: reliability score, avg days-to-pay/collect, 12-month
 * volume, then SUBTABS (open items | payments), each a paginated table whose
 * rows drill into the real document flyout in place via TxnLink. The
 * row-click flyout for ANY customer/vendor table (cockpits, module homes,
 * cash flyout).
 */
export function EntityDrawer({ party, name, side, onClose }: { party: string; name: string; side: 'ar' | 'ap'; onClose: () => void }) {
  const fmtMoney = useAnalyticsMoney()
  const money = (n: number) => fmtMoney(n, { compact: true })
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState(false)
  const [tab, setTab] = useState<'open' | 'payments'>('open')
  const [page, setPage] = useState(0)
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

  const rows: any[] = data ? (tab === 'open' ? (data.openItems ?? []) : (data.recentPayments ?? [])) : []
  const pageCount = Math.max(1, Math.ceil(rows.length / PER_PAGE))
  const safePage = Math.min(page, pageCount - 1)
  const visible = rows.slice(safePage * PER_PAGE, (safePage + 1) * PER_PAGE)
  const linkCls = 'font-medium text-slate-700 hover:text-teal-600 dark:text-slate-300 dark:hover:text-teal-400'

  return (
    <Drawer open onClose={onClose} size="md" title={name} description={side === 'ar' ? 'Customer payment history' : 'Vendor payment history'} bodyClassName="overflow-hidden flex flex-col p-0">
      {error ? (
        <p className="p-6 text-center text-sm text-slate-400">Could not load history.</p>
      ) : !data ? (
        <p className="p-6 text-center text-sm text-slate-400">Loading…</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="grid shrink-0 grid-cols-2 divide-x divide-slate-100 border-b border-slate-100 dark:divide-slate-800 dark:border-slate-800">
            <div className="px-5 py-3 text-center">
              <p className={cn('text-2xl font-bold tabular-nums', relTone(data.reliability))}>{data.reliability}</p>
              <p className="flex items-center justify-center gap-1 text-[10px] font-medium tracking-wide text-slate-400 uppercase dark:text-slate-500"><GaugeIcon size={10} /> Reliability</p>
            </div>
            <div className="px-5 py-3 text-center">
              <p className="text-2xl font-bold tabular-nums text-slate-800 dark:text-slate-100">{data.avgDays === null ? '—' : `${data.avgDays}d`}</p>
              <p className="text-[10px] font-medium tracking-wide text-slate-400 uppercase dark:text-slate-500">Avg {side === 'ar' ? 'to Collect' : 'to Pay'}</p>
            </div>
          </div>
          <div className="grid shrink-0 grid-cols-2 divide-x divide-slate-100 border-b border-slate-100 dark:divide-slate-800 dark:border-slate-800">
            <div className="px-5 py-3 text-center">
              <p className="text-lg font-semibold tabular-nums text-slate-700 dark:text-slate-200">{money(data.totalPaid)}</p>
              <p className="text-[10px] font-medium tracking-wide text-slate-400 uppercase dark:text-slate-500">{data.paymentCount} payments · 12mo</p>
            </div>
            <div className="px-5 py-3 text-center">
              <p className="text-lg font-semibold tabular-nums text-slate-700 dark:text-slate-200">{money(data.openBalance)}</p>
              <p className="text-[10px] font-medium tracking-wide text-slate-400 uppercase dark:text-slate-500">Open · {data.overdueCount} overdue</p>
            </div>
          </div>

          {/* Subtabs */}
          <div className="flex shrink-0 items-center gap-1 border-b border-slate-100 px-3 py-2 dark:border-slate-800">
            {([
              ['open', `Open items (${(data.openItems ?? []).length})`],
              ['payments', `Payments (${(data.recentPayments ?? []).length})`],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => { setTab(key); setPage(0) }}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-semibold transition-colors',
                  tab === key
                    ? 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100'
                    : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Paginated table — rows drill into the real document flyout. */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {visible.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-slate-400 dark:text-slate-500">
                {tab === 'open' ? 'No open items.' : 'No payments recorded.'}
              </p>
            ) : tab === 'open' ? (
              <table className="w-full text-sm">
                <tbody>
                  {visible.map((i, k: number) => (
                    <tr key={k} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                      <td className="px-4 py-1.5"><TxnLink entryId={i.entryId ?? ''} docKind={i.docKind} docId={i.docId} className={linkCls}>{i.docNumber || i.docKind}</TxnLink></td>
                      <td className="px-3 py-1.5 text-right text-xs tabular-nums text-slate-400">{i.dueDate ? dt(i.dueDate) : '—'}{i.overdue ? <span className="ml-1 text-red-500">overdue</span> : null}</td>
                      <td className="px-4 py-1.5 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{money(i.remaining)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {visible.map((p, k: number) => (
                    <tr key={k} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                      <td className="px-4 py-1.5 whitespace-nowrap text-xs tabular-nums text-slate-500 dark:text-slate-400">{dt(p.date)}</td>
                      <td className="px-3 py-1.5"><TxnLink entryId={p.entryId ?? ''} docKind={p.docKind} docId={p.docId} className={linkCls}>{p.docNumber || p.docKind}</TxnLink></td>
                      <td className="px-4 py-1.5 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{money(p.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Pager */}
          {rows.length > PER_PAGE ? (
            <div className="flex shrink-0 items-center justify-between border-t border-slate-100 px-4 py-2 dark:border-slate-800">
              <p className="text-xs tabular-nums text-slate-400 dark:text-slate-500">
                {safePage * PER_PAGE + 1}–{Math.min((safePage + 1) * PER_PAGE, rows.length)} of {rows.length}
              </p>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setPage(Math.max(0, safePage - 1))}
                  disabled={safePage === 0}
                  className="rounded-md p-1 text-slate-500 transition-colors hover:bg-slate-100 disabled:opacity-30 dark:text-slate-400 dark:hover:bg-slate-800"
                  aria-label="Previous page"
                >
                  <ChevronLeft size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))}
                  disabled={safePage >= pageCount - 1}
                  className="rounded-md p-1 text-slate-500 transition-colors hover:bg-slate-100 disabled:opacity-30 dark:text-slate-400 dark:hover:bg-slate-800"
                  aria-label="Next page"
                >
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </Drawer>
  )
}
