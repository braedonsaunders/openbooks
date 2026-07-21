'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import {
  BarChart3, CalendarCheck, CheckCircle2, ClipboardCheck, Hourglass,
  Layers, PieChart as PieIcon, TrendingUp, UserRound,
} from 'lucide-react'
import { cn, Badge } from '@openbooks/ui'
import type { ExpensesDashboardData } from '../../../lib/expenses-dashboard'
import { KpiCard } from '../analytics/_ui/KpiCard'
import { Panel } from '../analytics/_ui/Panel'
import { Donut, Chart } from '../analytics/_ui/charts'
import { DrillDrawer, type DrillTarget } from '../analytics/_ui/DrillDrawer'
import { fmtMoney } from '../analytics/_ui/format'

const money = (n: number) => fmtMoney(n, { compact: true })
const money0 = (n: number) => fmtMoney(n)
const pct1 = (n: number) => `${Math.round(n * 10) / 10}%`

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'warning'> = {
  approved: 'success',
  pending_approval: 'warning',
  draft: 'secondary',
}

/**
 * Expense-reports dashboard — the /expenses cockpit. The Spend Velocity
 * "Expenses" tab moved here from analytics (top spenders, category
 * current-vs-prior, expense-vs-bill trend — same visuals) with the approval
 * pipeline on top: what's waiting, what's approved-but-unposted, what posted
 * this month. Queue rows open the report's native flyout on the list route.
 */
export function ExpensesDashboard({ data }: { data: ExpensesDashboardData }) {
  const t = useTranslations('expenses.dashboard')
  const [drill, setDrill] = useState<DrillTarget | null>(null)
  const topCats = data.categories.slice(0, 8)
  const drillRow = 'cursor-pointer transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50'

  return (
    <div className="space-y-5">
      {/* Approval pipeline + spend-health vitals */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <KpiCard
          icon={Hourglass}
          accent="amber"
          label={t('vitals.pending')}
          value={money(data.pipeline.pendingTotal)}
          sub={t('vitals.pendingSub', { count: data.pipeline.pendingCount })}
          tone={data.pipeline.pendingCount > 0 ? 'negative' : 'neutral'}
        />
        <KpiCard
          icon={ClipboardCheck}
          accent="sky"
          label={t('vitals.awaiting')}
          value={money(data.pipeline.approvedTotal)}
          sub={t('vitals.awaitingSub', { count: data.pipeline.approvedCount })}
        />
        <KpiCard
          icon={CalendarCheck}
          accent="emerald"
          label={t('vitals.month')}
          value={money(data.pipeline.postedMonthTotal)}
          sub={t('vitals.monthSub', { count: data.pipeline.postedMonthCount })}
          tone="positive"
        />
        <KpiCard
          icon={UserRound}
          accent="violet"
          label={t('vitals.highSpenders')}
          value={String(data.summary.highSpenderCount)}
          sub={t('vitals.highSpendersSub')}
          tone={data.summary.highSpenderCount > 0 ? 'negative' : 'neutral'}
        />
        <KpiCard
          icon={TrendingUp}
          accent="red"
          label={t('vitals.creep')}
          value={money(data.summary.categoryIncreaseTotal)}
          sub={t('vitals.creepSub')}
          tone={data.summary.categoryIncreaseTotal > 0 ? 'negative' : 'neutral'}
        />
      </div>

      {/* Category donut + monthly trend */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        <div className="lg:col-span-4">
          <Panel title={t('panels.categories')} icon={PieIcon} hint={t('panels.categoriesHint')}>
            <Donut data={topCats.map((c) => ({ name: c.categoryName, value: c.currentAmount }))} height={250} />
          </Panel>
        </div>
        <div className="lg:col-span-8">
          <Panel title={t('panels.trend')} icon={BarChart3} hint={t('panels.trendHint')}>
            <Chart
              height={250}
              option={{
                grid: { top: 26, bottom: 26, left: 60, right: 12 },
                legend: { top: 0 },
                tooltip: { trigger: 'axis', valueFormatter: (v: any) => money0(Number(v ?? 0)) },
                xAxis: { type: 'category', data: data.monthlyTrends.map((m) => m.month) },
                yAxis: { type: 'value', axisLabel: { formatter: (v: number) => money(v) } },
                series: [
                  { name: t('series.bills'), type: 'bar', stack: 's', data: data.monthlyTrends.map((m) => m.billAmount), itemStyle: { color: '#6366f1' } },
                  { name: t('series.expenses'), type: 'bar', stack: 's', data: data.monthlyTrends.map((m) => m.expenseAmount), itemStyle: { color: '#ec4899' } },
                ],
              }}
            />
          </Panel>
        </div>
      </div>

      {/* Approval queue + top spenders + categories */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Panel title={t('panels.queue')} icon={CheckCircle2} hint={t('panels.queueHint')} bodyClassName="p-0">
          {data.queue.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-slate-400 dark:text-slate-500">{t('panels.queueEmpty')}</p>
          ) : (
            <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
              {data.queue.map((q) => (
                <li key={q.id}>
                  <Link
                    href={`/expenses/reports?expense=${q.id}` as never}
                    className="flex items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-slate-800 dark:text-slate-200">
                        {q.employee ?? q.documentNumber}
                      </span>
                      <span className="block truncate text-xs text-slate-400 dark:text-slate-500">
                        {q.documentNumber} · {q.date}
                      </span>
                    </span>
                    <Badge variant={STATUS_VARIANT[q.status] ?? 'secondary'}>{q.status.replace('_', ' ')}</Badge>
                    <span className="shrink-0 font-semibold tabular-nums text-slate-900 dark:text-slate-100">{money0(q.total)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title={t('panels.spenders')} icon={UserRound} hint={t('panels.spendersHint')} bodyClassName="p-0">
          <div className="max-h-88 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white dark:bg-slate-900">
                <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                  <th className="px-4 py-2 text-left font-medium">{t('table.employee')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('table.spend')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('table.reports')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('table.change')}</th>
                </tr>
              </thead>
              <tbody>
                {data.topSpenders.slice(0, 25).map((sp) => (
                  <tr
                    key={sp.employeeId}
                    onClick={() => setDrill({ kind: 'party', id: sp.employeeId, name: sp.employeeName })}
                    className={cn('border-b border-slate-50 last:border-0 dark:border-slate-800/60', drillRow)}
                  >
                    <td className="max-w-40 truncate px-4 py-2 font-medium text-slate-800 dark:text-slate-200" title={sp.employeeName}>{sp.employeeName}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">{money0(sp.totalSpend)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-400">{sp.reportCount}</td>
                    <td className={cn('px-4 py-2 text-right font-semibold tabular-nums', sp.changePct > 20 ? 'text-rose-600 dark:text-rose-400' : sp.changePct < 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500')}>
                      {sp.changePct > 0 ? '+' : ''}{pct1(sp.changePct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title={t('panels.categoryTable')} icon={Layers} hint={t('panels.categoryTableHint')} bodyClassName="p-0">
          <div className="max-h-88 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white dark:bg-slate-900">
                <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                  <th className="px-4 py-2 text-left font-medium">{t('table.category')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('table.current')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('table.prior')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('table.change')}</th>
                </tr>
              </thead>
              <tbody>
                {data.categories.slice(0, 25).map((c) => (
                  <tr
                    key={c.categoryId}
                    onClick={() => setDrill({ kind: 'account', id: c.categoryId, name: c.categoryName })}
                    className={cn('border-b border-slate-50 last:border-0 dark:border-slate-800/60', drillRow)}
                  >
                    <td className="max-w-40 truncate px-4 py-2 font-medium text-slate-800 dark:text-slate-200" title={c.categoryName}>{c.categoryName}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">{money0(c.currentAmount)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-400">{money0(c.priorAmount)}</td>
                    <td className={cn('px-4 py-2 text-right font-semibold tabular-nums', c.changePct > 10 ? 'text-rose-600 dark:text-rose-400' : c.changePct < 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500')}>
                      {c.changePct > 0 ? '+' : ''}{pct1(c.changePct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <DrillDrawer target={drill} from={data.period.from} to={data.period.to} onClose={() => setDrill(null)} />
    </div>
  )
}
