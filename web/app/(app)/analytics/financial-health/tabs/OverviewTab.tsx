'use client'

import { useState } from 'react'
import { AlertTriangle, Lightbulb, Zap, Table2, ChartArea } from 'lucide-react'
import { Sparkline, cn } from '@openbooks/ui'
import type { HealthData, Insight } from '../../../../../lib/analytics/health-data'
import { Panel, SegToggle } from '../../_ui/Panel'
import { TrendChart } from '../../_ui/charts'
import { useAnalyticsMoney, fmtPct } from '../../_ui/format'

export function OverviewTab({ data }: { data: HealthData }) {
  const fmtMoney = useAnalyticsMoney()
  const [view, setView] = useState<'revenue' | 'margin'>('revenue')
  const m = data.monthly
  const labels = m.map((p) => p.label)

  const spark = (key: 'revenue' | 'grossMarginPct' | 'operatingIncome') => m.map((p) => p[key])

  return (
    <div className="space-y-5">
      {/* Sparkline row */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SparkCard label="Revenue Trend" points={spark('revenue')} last={fmtMoney(data.figures.revenue, { compact: true })} />
        <SparkCard label="Margin Trend" points={spark('grossMarginPct')} last={fmtPct(data.figures.revenue > 0 ? data.figures.grossProfit / data.figures.revenue : 0)} />
        <SparkCard label="Op Income Trend" points={spark('operatingIncome')} last={fmtMoney(data.figures.operatingIncome, { compact: true })} />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Panel
            title="Performance Trend"
            icon={ChartArea}
            actions={
              <SegToggle
                value={view}
                onChange={setView}
                options={[
                  { value: 'revenue', label: 'Revenue' },
                  { value: 'margin', label: 'Margins' },
                ]}
              />
            }
          >
            {view === 'revenue' ? (
              <TrendChart
                labels={labels}
                area
                series={[
                  { name: 'Revenue', data: m.map((p) => p.revenue), color: '#0d9488' },
                  { name: 'Gross Profit', data: m.map((p) => p.grossProfit), color: '#6366f1' },
                  { name: 'Operating Income', data: m.map((p) => p.operatingIncome), color: '#f59e0b' },
                ]}
              />
            ) : (
              <TrendChart
                labels={labels}
                pctAxis
                series={[
                  { name: 'Gross Margin', data: m.map((p) => p.grossMarginPct), color: '#0d9488', pct: true },
                  { name: 'Operating Margin', data: m.map((p) => p.operatingMarginPct), color: '#f59e0b', pct: true },
                ]}
              />
            )}
          </Panel>

          <Panel title="P&L Summary" icon={Table2} bodyClassName="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
                  <th className="px-4 py-2 text-left font-medium">Line Item</th>
                  <th className="px-4 py-2 text-right font-medium">Current</th>
                  <th className="px-4 py-2 text-right font-medium">Prior Year</th>
                  <th className="px-4 py-2 text-right font-medium">Change</th>
                  <th className="px-4 py-2 text-right font-medium">Change %</th>
                </tr>
              </thead>
              <tbody>
                {data.pnlSummary.map((l) => {
                  // Favorability, not sign: a COGS/OpEx/Other-Expense increase is bad.
                  const isCost = l.key === 'cogs' || l.key === 'opex' || l.key === 'otherExpense'
                  const good = isCost ? l.change <= 0 : l.change >= 0
                  const changeCls = good ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
                  return (
                  <tr key={l.key} className={cn('border-b border-slate-50 last:border-0 dark:border-slate-800/60', l.strong && 'bg-slate-50/50 dark:bg-slate-800/20')}>
                    <td className={cn('px-4 py-2', l.strong ? 'font-semibold text-slate-900 dark:text-slate-100' : 'text-slate-500 dark:text-slate-400')}>{l.label}</td>
                    <td className={cn('px-4 py-2 text-right tabular-nums', l.strong ? 'font-semibold text-slate-900 dark:text-slate-100' : 'text-slate-700 dark:text-slate-300')}>{fmtMoney(l.current)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">{fmtMoney(l.prior)}</td>
                    <td className={cn('px-4 py-2 text-right tabular-nums', changeCls)}>{fmtMoney(l.change)}</td>
                    <td className={cn('px-4 py-2 text-right tabular-nums', changeCls)}>
                      {l.changePct === null ? '—' : fmtPct(l.changePct)}
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </Panel>
        </div>

        {/* Insights */}
        <div className="space-y-5">
          <InsightSection severity="issue" title="Issues" icon={AlertTriangle} accent="red" insights={data.insights.filter((i) => i.severity === 'issue')} />
          <InsightSection severity="rec" title="Recommendations" icon={Lightbulb} accent="emerald" insights={data.insights.filter((i) => i.severity === 'rec')} />
          <InsightSection severity="anomaly" title="Anomalies" icon={Zap} accent="amber" insights={data.insights.filter((i) => i.severity === 'anomaly')} />
        </div>
      </div>
    </div>
  )
}

function SparkCard({ label, points, last }: { label: string; points: number[]; last: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</span>
        <span className="text-sm font-bold text-slate-900 tabular-nums dark:text-slate-100">{last}</span>
      </div>
      <Sparkline points={points.length >= 2 ? points : [0, 0]} auto goodWhenRising area className="mt-2 h-9 w-full" />
    </div>
  )
}

const ACCENT_DOT: Record<string, string> = {
  red: 'text-red-500',
  emerald: 'text-emerald-500',
  amber: 'text-amber-500',
}

function InsightSection({
  title,
  icon: Icon,
  accent,
  insights,
}: {
  severity: Insight['severity']
  title: string
  icon: typeof AlertTriangle
  accent: 'red' | 'emerald' | 'amber'
  insights: Insight[]
}) {
  return (
    <Panel
      title={title}
      icon={Icon}
      actions={
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400">{insights.length}</span>
      }
      bodyClassName="p-0"
    >
      {insights.length === 0 ? (
        <p className="px-4 py-4 text-xs text-slate-400 dark:text-slate-500">Nothing flagged.</p>
      ) : (
        <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
          {insights.map((ins, i) => (
            <li key={i} className="flex gap-2.5 px-4 py-2.5">
              <Icon size={14} className={cn('mt-0.5 shrink-0', ACCENT_DOT[accent])} />
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-800 dark:text-slate-200">{ins.title}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">{ins.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}
