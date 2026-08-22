'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ClipboardList, Download, Search } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { cn, Input } from '@openbooks/ui'
import type { HealthData, BudgetRow } from '../../../../../lib/analytics/health-data'
import { Panel } from '../../_ui/Panel'
import { KpiCard } from '../../_ui/KpiCard'
import { exportCsv } from '../../_ui/exportCsv'
import { useAnalyticsMoney, fmtPct } from '../../_ui/format'

const STATUS_STYLE: Record<BudgetRow['status'], string> = {
  'on-track': 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
  watch: 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
  over: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
  'no-budget': 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
}

/**
 * Budget vs Actual. Real mode when a budget scenario covers the period
 * (per-account variance from budget_lines). When no formal scenario exists,
 * the tab links to the real budget authoring workflow instead of inventing
 * benchmark data.
 */
export function BudgetTab({ data }: { data: HealthData }) {
  return data.budget.scenario ? <RealBudget data={data} /> : <NoBudget />
}

/* ------------------------------------------------------------ real budgets */
type Filter = 'all' | 'over' | 'watch' | 'on-track' | 'no-budget'
const PAGE = 30

function RealBudget({ data }: { data: HealthData }) {
  const fmtMoney = useAnalyticsMoney()
  const t = useTranslations('analytics.financialHealth.budget')
  const tb = useTranslations('budgets')
  const b = data.budget
  const scenario = b.scenario!
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return b.rows.filter((r) => (filter === 'all' || r.status === filter) && (!needle || r.name.toLowerCase().includes(needle)))
  }, [b.rows, filter, query])
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE))
  const pageNo = Math.min(page, totalPages)
  const pageRows = filtered.slice((pageNo - 1) * PAGE, pageNo * PAGE)

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: b.rows.length, over: 0, watch: 0, 'on-track': 0, 'no-budget': 0 }
    for (const r of b.rows) c[r.status]++
    return c
  }, [b.rows])

  const budgeted = b.rows.filter((r) => r.status !== 'no-budget')
  const overCount = counts.over
  const coverage = b.rows.length ? budgeted.length / b.rows.length : 0
  const statusLabel = (status: BudgetRow['status']) => t(`status.${status}`)

  return (
    <div className="space-y-5">
      <p className="flex items-start gap-2 rounded-lg bg-teal-50 p-3 text-xs leading-relaxed text-teal-800 dark:bg-teal-950/30 dark:text-teal-300">
        <ClipboardList size={14} className="mt-0.5 shrink-0" />
        <span>
          {t.rich('measuredAgainst', {
            name: scenario.name,
            year: scenario.fiscalYear,
            status: tb(`status.${scenario.status}`),
            strong: (chunks) => <span className="font-semibold">{chunks}</span>,
            link: (chunks) => <Link href="/budgets" className="font-semibold underline">{chunks}</Link>,
          })}
        </span>
      </p>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={ClipboardList} accent="teal" label={t('totalBudget')} value={fmtMoney(b.totals.budget, { compact: true })} sub={t('budgetedAccounts', { count: budgeted.length })} />
        <KpiCard icon={ClipboardList} accent="sky" label={t('totalActual')} value={fmtMoney(b.totals.actual, { compact: true })} sub={t('normalizedIncome')} />
        <KpiCard icon={ClipboardList} accent={overCount > 0 ? 'red' : 'emerald'} label={t('overBudget')} value={String(overCount)} sub={t('onWatch', { count: counts.watch })} tone={overCount > 0 ? 'negative' : 'positive'} />
        <KpiCard icon={ClipboardList} accent="violet" label={t('coverage')} value={fmtPct(coverage)} sub={t('coverageSub')} />
      </div>

      <Panel
        title={t('tableTitle', { count: filtered.length })}
        icon={ClipboardList}
        bodyClassName="p-0"
        actions={
          <span className="flex items-center gap-2">
            <span className="relative">
              <Search size={13} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-slate-400" />
              <Input value={query} onChange={(e) => { setQuery(e.target.value); setPage(1) }} placeholder={t('search')} className="h-7 w-44 pl-8 text-xs" />
            </span>
            <button
              type="button"
              onClick={() => exportCsv('budget-vs-actual', [t('columns.account'), t('columns.type'), t('columns.budget'), t('columns.actual'), t('columns.variance'), t('columns.variancePct'), t('columns.status')], filtered.map((r) => [r.name, r.type, Math.round(r.budget), Math.round(r.actual), Math.round(r.variance), r.variancePct === null ? '' : (r.variancePct * 100).toFixed(1), statusLabel(r.status)]))}
              className="flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-500 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
            >
              <Download size={11} /> {t('csv')}
            </button>
          </span>
        }
      >
        <div className="flex items-center gap-1.5 border-b border-slate-100 px-4 py-2 dark:border-slate-800">
          {(Object.keys(counts) as Filter[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => { setFilter(k); setPage(1) }}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs font-medium',
                filter === k ? 'border-teal-500 bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300' : 'border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400',
              )}
            >
              {k === 'all' ? t('all') : statusLabel(k as BudgetRow['status'])} ({counts[k]})
            </button>
          ))}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                <th className="px-4 py-2 text-left font-medium">{t('columns.account')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('columns.budget')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('columns.actual')}</th>
                <th className="w-40 px-4 py-2 text-left font-medium">{t('columns.progress')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('columns.variance')}</th>
                <th className="px-4 py-2 text-center font-medium">{t('columns.status')}</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r) => {
                const ratio = Math.abs(r.budget) > 0 ? Math.max(0, r.actual / r.budget) : null
                return (
                  <tr key={r.accountId} className="border-b border-slate-50 last:border-0 dark:border-slate-800/60">
                    <td className="px-4 py-2 text-slate-700 dark:text-slate-300">{r.name}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{r.status === 'no-budget' ? '—' : fmtMoney(r.budget, { compact: true })}</td>
                    <td className="px-4 py-2 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{fmtMoney(r.actual, { compact: true })}</td>
                    <td className="px-4 py-2">
                      {ratio === null ? (
                        <span className="text-xs text-slate-300 dark:text-slate-600">—</span>
                      ) : (
                        <span className="flex items-center gap-2">
                          <span className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                            <span className={cn('block h-full rounded-full', r.status === 'over' ? 'bg-red-500' : r.status === 'watch' ? 'bg-amber-500' : 'bg-emerald-500')} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
                          </span>
                          <span className="text-[11px] tabular-nums text-slate-400">{Math.round(ratio * 100)}%</span>
                        </span>
                      )}
                    </td>
                    <td className={cn('px-4 py-2 text-right tabular-nums', r.status === 'no-budget' ? 'text-slate-400 dark:text-slate-500' : r.favorable ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
                      {r.status === 'no-budget' ? '—' : `${r.variance >= 0 ? '+' : ''}${fmtMoney(r.variance, { compact: true })}`}
                    </td>
                    <td className="px-4 py-2 text-center"><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', STATUS_STYLE[r.status])}>{statusLabel(r.status)}</span></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
            <span>{t('showing', { from: (pageNo - 1) * PAGE + 1, to: Math.min(pageNo * PAGE, filtered.length), total: filtered.length })}</span>
            <span className="flex items-center gap-1">
              <button type="button" disabled={pageNo <= 1} onClick={() => setPage(pageNo - 1)} className="rounded border border-slate-200 px-2 py-1 disabled:opacity-40 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">{t('previous')}</button>
              <span className="px-2 tabular-nums">{pageNo} / {totalPages}</span>
              <button type="button" disabled={pageNo >= totalPages} onClick={() => setPage(pageNo + 1)} className="rounded border border-slate-200 px-2 py-1 disabled:opacity-40 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">{t('next')}</button>
            </span>
          </div>
        )}
      </Panel>
    </div>
  )
}

function NoBudget() {
  const t = useTranslations('analytics.financialHealth.budget')
  return <Panel title={t('noBudgetTitle')} icon={ClipboardList}>
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      <ClipboardList size={28} className="text-slate-300 dark:text-slate-600" />
      <p className="max-w-lg text-sm text-slate-500 dark:text-slate-400">{t('noBudgetDescription')}</p>
      <Link href="/budgets" className="rounded-md bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800">{t('createBudget')}</Link>
    </div>
  </Panel>
}
