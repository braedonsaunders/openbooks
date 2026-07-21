'use client'

import { useEffect, useState } from 'react'
import { Drawer, cn } from '@openbooks/ui'
import { Gauge as GaugeIcon } from 'lucide-react'
import { TxnLink } from '../../reports/TxnLink'
import { fmtMoney } from './format'

const money = (n: number) => fmtMoney(n, { compact: true })

/**
 * Party reliability drawer — the cash-flyout entity drill promoted to a
 * shared component: reliability score, avg days-to-pay/collect, 12-month
 * volume, open items and recent payments (rows drill in place via TxnLink).
 * The row-click flyout for ANY customer/vendor table (cockpits, module
 * homes, cash flyout).
 */
export function EntityDrawer({ party, name, side, onClose }: { party: string; name: string; side: 'ar' | 'ap'; onClose: () => void }) {
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
