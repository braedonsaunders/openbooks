'use client'

import { useEffect, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { cn, Drawer, Input } from '@openbooks/ui'
import { TxnLink } from '../../reports/TxnLink'
import { GroupedBar } from './charts'
import { fmtMoney } from './format'

/**
 * Shared analytics drill-down drawer — the openbooks port of Gantry's
 * universal account/vendor flyout (3 KPI cards, monthly activity chart,
 * searchable + paginated transaction list with record deep-links, breakdown
 * view). Fetches per-entity on open via /api/analytics/drill — never a
 * preloaded window.
 */
export interface DrillTarget {
  kind: 'account' | 'party'
  id: string
  name: string
  /** Optional context line under the title (e.g. account number, tier). */
  sub?: string
}

interface DrillEntry {
  date: string
  entryId: string | null
  docId: string | null
  docKind: string | null
  docNumber: string
  label: string
  memo: string
  amount: number
}

interface DrillData {
  mode: 'account' | 'party'
  total: number
  count: number
  entries: DrillEntry[]
  monthly: { month: string; amount: number }[]
  breakdown: { name: string; amount: number; count: number }[]
}

const PAGE = 50
const money = (n: number) => fmtMoney(n, { compact: true })
const KIND_LABEL: Record<string, string> = {
  vendor_bill: 'Bill',
  vendor_credit: 'Vendor Credit',
  vendor_payment: 'Payment',
  customer_invoice: 'Invoice',
  customer_credit: 'Credit Memo',
  customer_payment: 'Customer Payment',
  expense_report: 'Expense Report',
  purchase_order: 'PO',
  sales_order: 'SO',
  check: 'Check',
  journal: 'Journal',
  deposit: 'Deposit',
  transfer: 'Transfer',
  card_charge: 'Card Charge',
  card_refund: 'Card Refund',
}
const kindLabel = (k: string | null) => (k ? (KIND_LABEL[k] ?? k.replace(/_/g, ' ')) : 'Journal')

export function DrillDrawer({ target, from, to, onClose }: { target: DrillTarget | null; from: string; to: string; onClose: () => void }) {
  const [data, setData] = useState<DrillData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<'txns' | 'breakdown' | 'trend'>('txns')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)

  useEffect(() => {
    if (!target) return
    setData(null)
    setError(null)
    setView('txns')
    setQuery('')
    setPage(1)
    const ctrl = new AbortController()
    fetch(`/api/analytics/drill?${target.kind}=${target.id}&from=${from}&to=${to}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => { if (e.name !== 'AbortError') setError(String(e.message ?? e)) })
    return () => ctrl.abort()
  }, [target, from, to])

  const filtered = useMemo(() => {
    if (!data) return []
    const needle = query.trim().toLowerCase()
    if (!needle) return data.entries
    return data.entries.filter((e) => e.label.toLowerCase().includes(needle) || e.memo.toLowerCase().includes(needle) || e.docNumber.toLowerCase().includes(needle))
  }, [data, query])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE))
  const pageNo = Math.min(page, totalPages)
  const pageRows = filtered.slice((pageNo - 1) * PAGE, pageNo * PAGE)

  if (!target) return null
  const monthLabel = (ym: string) => {
    const [y, m] = ym.split('-').map(Number)
    return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' })
  }
  const fmtDate = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

  return (
    <Drawer open onClose={onClose} size="lg" title={target.name} description={target.sub ?? `${from} – ${to}`} bodyClassName="overflow-hidden flex flex-col p-0">
      {/* Stat strip */}
      <div className="grid grid-cols-3 divide-x divide-slate-100 border-b border-slate-100 dark:divide-slate-800 dark:border-slate-800">
        {[
          { label: 'Total', value: data ? money(data.total) : '…' },
          { label: 'Transactions', value: data ? String(data.count) : '…' },
          { label: 'Avg', value: data && data.count > 0 ? money(data.total / data.count) : '…' },
        ].map((s) => (
          <div key={s.label} className="px-5 py-3 text-center">
            <p className="text-lg font-semibold text-slate-800 tabular-nums dark:text-slate-100">{s.value}</p>
            <p className="text-[10px] font-medium tracking-wider text-slate-400 uppercase dark:text-slate-500">{s.label}</p>
          </div>
        ))}
      </div>

      {/* View pills + search */}
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2 dark:border-slate-800">
        {(
          [
            ['txns', 'Transactions'],
            ['breakdown', data?.mode === 'account' ? 'By Party' : 'By Type'],
            ['trend', 'Monthly Trend'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setView(k)}
            className={cn(
              'rounded-full border px-2.5 py-1 text-xs font-medium',
              view === k ? 'border-teal-500 bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300' : 'border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400',
            )}
          >
            {label}
          </button>
        ))}
        {view === 'txns' ? (
          <div className="relative ml-auto w-48">
            <Search size={13} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-slate-400" />
            <Input value={query} onChange={(e) => { setQuery(e.target.value); setPage(1) }} placeholder="Search…" className="h-7 pl-8 text-xs" />
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <p className="px-6 py-8 text-center text-sm text-red-500">Failed to load: {error}</p>
        ) : !data ? (
          <p className="px-6 py-8 text-center text-sm text-slate-400">Loading…</p>
        ) : view === 'trend' ? (
          <div className="p-4">
            <GroupedBar labels={data.monthly.map((m) => monthLabel(m.month))} height={260} series={[{ name: 'Amount', data: data.monthly.map((m) => m.amount), color: '#0d9488' }]} />
          </div>
        ) : view === 'breakdown' ? (
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="px-6 py-2 text-left font-medium">{data.mode === 'account' ? 'Party' : 'Document Type'}</th>
                <th className="px-3 py-2 text-right font-medium">Count</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-6 py-2 text-right font-medium">Share</th>
              </tr>
            </thead>
            <tbody>
              {data.breakdown.map((b) => (
                <tr key={b.name} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                  <td className="px-6 py-2.5 text-slate-700 dark:text-slate-300">{data.mode === 'party' ? kindLabel(b.name) : b.name}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-slate-500 dark:text-slate-400">{b.count}</td>
                  <td className="px-3 py-2.5 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{money(b.amount)}</td>
                  <td className="px-6 py-2.5 text-right tabular-nums text-slate-500 dark:text-slate-400">{data.total > 0 ? `${((Math.abs(b.amount) / Math.abs(data.total)) * 100).toFixed(1)}%` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : filtered.length === 0 ? (
          <p className="px-6 py-8 text-center text-sm text-slate-400">{query ? 'No transactions match your search.' : 'No transactions in this period.'}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="px-6 py-2 text-left font-medium">Date</th>
                <th className="px-3 py-2 text-left font-medium">Document</th>
                <th className="px-3 py-2 text-left font-medium">{data.mode === 'account' ? 'Party' : 'Type'}</th>
                <th className="px-3 py-2 text-left font-medium">Memo</th>
                <th className="px-6 py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((e, i) => (
                <tr key={`${e.entryId ?? e.docId}-${i}`} className="group border-b border-slate-50 last:border-0 hover:bg-slate-50/60 dark:border-slate-800/60 dark:hover:bg-slate-800/30">
                  <td className="px-6 py-2 text-xs whitespace-nowrap tabular-nums text-slate-500 dark:text-slate-400">{fmtDate(e.date)}</td>
                  <td className="px-3 py-2">
                    {e.entryId || e.docId ? (
                      <TxnLink entryId={e.entryId ?? ''} docKind={e.docKind} docId={e.docId} className="font-medium text-slate-700 group-hover:text-teal-700 dark:text-slate-200 dark:group-hover:text-teal-300">
                        {e.docNumber || kindLabel(e.docKind)}
                      </TxnLink>
                    ) : (
                      <span className="text-slate-500 dark:text-slate-400">{e.docNumber || '—'}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">{data.mode === 'account' ? e.label : kindLabel(e.docKind)}</td>
                  <td className="max-w-48 truncate px-3 py-2 text-xs text-slate-400 dark:text-slate-500" title={e.memo}>{e.memo || '—'}</td>
                  <td className={cn('px-6 py-2 text-right font-medium tabular-nums', e.amount < 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-800 dark:text-slate-200')}>{money(e.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer: pagination + truncation note */}
      {data && view === 'txns' && (filtered.length > PAGE || data.count > data.entries.length) ? (
        <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
          <span>
            Showing {(pageNo - 1) * PAGE + 1}–{Math.min(pageNo * PAGE, filtered.length)} of {filtered.length}
            {data.count > data.entries.length ? ` (detail capped at ${data.entries.length} of ${data.count})` : ''}
          </span>
          {totalPages > 1 ? (
            <div className="flex items-center gap-1">
              <button type="button" disabled={pageNo <= 1} onClick={() => setPage(pageNo - 1)} className="rounded border border-slate-200 px-2 py-1 disabled:opacity-40 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">Prev</button>
              <span className="px-2 tabular-nums">{pageNo} / {totalPages}</span>
              <button type="button" disabled={pageNo >= totalPages} onClick={() => setPage(pageNo + 1)} className="rounded border border-slate-200 px-2 py-1 disabled:opacity-40 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">Next</button>
            </div>
          ) : null}
        </div>
      ) : null}
    </Drawer>
  )
}
