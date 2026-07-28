'use client'

import { useMoney } from '@/components/money-provider'
import { useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent, cn } from '@openbooks/ui'
import type { PnlLine } from '@openbooks/schema'
import { PagedTable } from '../../../../components/paged-table'
import { add, cmp, neg } from '@openbooks/engine/src/money.ts'

interface CategoryRow { category: string; amount: string }
interface AccountRow { accountId: string; number: string | null; name: string; amount: string }

export interface FinancialsData {
  /** measure key → dollar value (margin_pct is a percentage). */
  measures: Record<string, string | number>
  /** ordered P&L lines from the project type's financial profile. */
  layout: PnlLine[]
  costByCategory: CategoryRow[]
  costByAccount: AccountRow[]
  projectType: string | null
  /** A tenant-configured capped project type owns cost-budget semantics. */
  costBudgetApplies: boolean
  /** Whether statistical overhead is already a component of total job cost. */
  overheadIncludedInTotalCost: boolean
}

/** Measures that read better as "good when positive, bad when negative". */
const SIGNED_GOOD = new Set(['gross_profit', 'could_be_invoiced', 'remaining_budget'])
/** Measures that carry an explanatory hint. */
const HINTED = new Set(['invoiced_to_date', 'could_be_invoiced', 'committed_cost', 'total_price', 'total_cost', 'overhead'])

function Line({ label, hint, value, variant, tone }: {
  label: string; hint?: string; value: ReactNode; variant: 'line' | 'subtotal' | 'total'; tone?: 'good' | 'bad'
}) {
  return (
    <div className={cn('flex items-baseline justify-between gap-4 px-4 py-2',
      variant === 'subtotal' && 'bg-slate-50/60 dark:bg-slate-800/40',
      variant === 'total' && 'bg-slate-50 dark:bg-slate-800/60')}>
      <div className="min-w-0">
        <div className={cn('text-sm', variant === 'line' ? 'text-slate-600 dark:text-slate-300' : 'font-semibold text-slate-900 dark:text-slate-100', variant === 'total' && 'text-base')}>{label}</div>
        {hint ? <div className="text-xs text-slate-400 dark:text-slate-500">{hint}</div> : null}
      </div>
      <div className={cn('shrink-0 tabular-nums',
        variant === 'line' ? 'text-sm text-slate-700 dark:text-slate-200' : 'font-semibold text-slate-900 dark:text-slate-100',
        variant === 'total' && 'text-lg',
        tone === 'good' && '!text-teal-700 dark:!text-teal-300',
        tone === 'bad' && '!text-red-600 dark:!text-red-400')}>{value}</div>
    </div>
  )
}

export function FinancialsTab({ data }: {
  data: FinancialsData
}) {
  const { money } = useMoney()
  const t = useTranslations('projects')
  const tCommon = useTranslations('common')
  const [inner, setInner] = useState<'category' | 'account'>('category')

  const m = data.measures
  const measureLabel = (key: string) => {
    try { return t(`measures.${key}` as never) } catch { return key.replace(/_/g, ' ') }
  }
  const measureHint = (key: string) => {
    if (!HINTED.has(key)) return undefined
    try { return t(`measures.hints.${key}` as never) } catch { return undefined }
  }
  const measureTone = (key: string, v: string | number): 'good' | 'bad' | undefined => {
    if (SIGNED_GOOD.has(key)) return cmp(String(v), '0') > 0 ? 'good' : cmp(String(v), '0') < 0 ? 'bad' : undefined
    return undefined
  }
  const fmt = (key: string, v: string | number): string => (key === 'margin_pct' ? `${Number(v).toFixed(1)}%` : money(v))

  // Budget bar (derived from measures).
  const costBudget = m.cost_budget ?? 0
  const actualCost = m.actual_cost ?? 0
  const committedCost = m.committed_cost ?? 0
  const totalCost = m.total_cost ?? 0
  const scale = Math.max(Number(costBudget), Number(totalCost), 1)
  const actualPct = Math.min(100, (Number(actualCost) / scale) * 100)
  const committedPct = Math.min(100 - actualPct, (Number(committedCost) / scale) * 100)
  const budgetMarkerPct = Math.min(100, (Number(costBudget) / scale) * 100)
  const overBudget = cmp(String(totalCost), String(costBudget)) > 0 && cmp(String(costBudget), '0') > 0

  const innerTabs = [
    { key: 'category' as const, label: t('cockpit.costByCategory') },
    { key: 'account' as const, label: t('cockpit.costByAccount') },
  ]
  const budgetAwareLayout = data.costBudgetApplies
    ? data.layout
    : data.layout.filter((line) => line.measure !== 'cost_budget' && line.measure !== 'remaining_budget')
  // Overhead is a component of total cost for profiles that opt into it. Some
  // older saved profiles appended the display line after gross profit, which
  // visually implied a second deduction even though the calculation already
  // included it. Keep the tenant-authored line treatment, but place it inside
  // the cost block immediately before Total job cost.
  const overheadLine = budgetAwareLayout.find((line) => line.measure === 'overhead')
  const layoutWithoutIncludedOverhead = overheadLine
    ? budgetAwareLayout.filter((line) => line.measure !== 'overhead')
    : budgetAwareLayout
  const totalCostIndex = layoutWithoutIncludedOverhead.findIndex((line) => line.measure === 'total_cost')
  const visibleLayout = overheadLine && data.overheadIncludedInTotalCost && totalCostIndex >= 0
    ? [
        ...layoutWithoutIncludedOverhead.slice(0, totalCostIndex),
        overheadLine,
        ...layoutWithoutIncludedOverhead.slice(totalCostIndex),
      ]
    : overheadLine && !data.overheadIncludedInTotalCost
      ? layoutWithoutIncludedOverhead
      : budgetAwareLayout

  return (
    <div className="space-y-6">
      {/* Profile-driven P&L statement. The full-width presentation keeps the
          revenue → cost → profit sequence visually explicit. */}
      <Card>
        <CardContent className="p-0">
          <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('cockpit.pnlTitle')}</h2>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800/60">
            {visibleLayout.map((line, i) => {
              const v = m[line.measure] ?? 0
              if (line.hideWhenZero && v === 0) return null
              return (
                <Line
                  key={`${line.measure}-${i}`}
                  label={line.label ?? measureLabel(line.measure)}
                  hint={line.variant === 'line' ? measureHint(line.measure) : undefined}
                  value={fmt(line.measure, v)}
                  variant={line.variant}
                  tone={line.variant === 'total' && line.measure === 'gross_profit'
                    ? (cmp(String(v), '0') > 0 ? 'good' : cmp(String(v), '0') < 0 ? 'bad' : undefined)
                    : measureTone(line.measure, v)}
                />
              )
            })}
          </div>
        </CardContent>
      </Card>

      {overheadLine && !data.overheadIncludedInTotalCost ? (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-4 p-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {overheadLine.label ?? measureLabel('overhead')}
                </h2>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  {t('cockpit.informationalOnly')}
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('measures.hints.overhead_informational')}</p>
            </div>
            <div className="text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">{money(m.overhead ?? 0)}</div>
          </CardContent>
        </Card>
      ) : null}

      {/* A cost ceiling is meaningful only when the project type explicitly
          uses capped/not-to-exceed pricing. Other types still show their
          actual and committed costs in the statement and breakdown below. */}
      {data.costBudgetApplies ? (
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('cockpit.budgetBarTitle')}</h2>
              <span className={cn('text-sm font-medium tabular-nums', overBudget ? 'text-red-600 dark:text-red-400' : 'text-teal-700 dark:text-teal-300')}>
                {overBudget ? t('cockpit.overBudget', { amount: money(add(String(totalCost), neg(String(costBudget)))) })
                  : cmp(String(costBudget), '0') > 0 ? t('cockpit.underBudget', { amount: money(add(String(costBudget), neg(String(totalCost)))) })
                    : t('cockpit.noCostBudget')}
              </span>
            </div>
            <div className="relative h-6 w-full overflow-hidden rounded-md bg-slate-100 dark:bg-slate-800">
              <div className="absolute inset-y-0 left-0 bg-teal-500" style={{ width: `${actualPct}%` }} title={t('cockpit.actualAmount', { amount: money(actualCost) })} />
              <div className="absolute inset-y-0 bg-amber-400" style={{ left: `${actualPct}%`, width: `${committedPct}%` }} title={t('cockpit.committedAmount', { amount: money(committedCost) })} />
              {cmp(String(costBudget), '0') > 0 ? <div className="absolute inset-y-0 w-0.5 bg-slate-900 dark:bg-white" style={{ left: `${budgetMarkerPct}%` }} title={t('cockpit.costBudgetAmount', { amount: money(costBudget) })} /> : null}
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
              <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-teal-500" /> {t('cockpit.actualAmount', { amount: money(actualCost) })}</span>
              <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-amber-400" /> {t('cockpit.committedAmount', { amount: money(committedCost) })}</span>
              <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-0.5 bg-slate-900 dark:bg-white" /> {t('cockpit.costBudgetAmount', { amount: money(costBudget) })}</span>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Cost breakdown — subtabs, never side-by-side (repository conventions). */}
      <div className="space-y-3">
        <nav className="-mb-px flex gap-1 border-b border-slate-200 dark:border-slate-800" aria-label={t('cockpit.costBreakdownAria')}>
          {innerTabs.map((tab) => (
            <button key={tab.key} type="button" onClick={() => setInner(tab.key)} aria-selected={inner === tab.key}
              className={cn('border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                inner === tab.key ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300'
                  : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200')}>
              {tab.label}
            </button>
          ))}
        </nav>
        {inner === 'category' ? (
          <PagedTable rows={data.costByCategory} rowKey={(r) => r.category} searchable
            empty={<p className="text-sm text-slate-500 dark:text-slate-400">{t('cockpit.noPostedCosts')}</p>}
            columns={[
              { key: 'category', header: t('cockpit.category'), search: (r) => r.category, cell: (r) => (r.category === 'cogs' || r.category === 'operating_expense' ? t(`cockpit.categories.${r.category}`) : r.category) },
              { key: 'amount', header: tCommon('labels.amount'), align: 'right', cell: (r) => money(r.amount) },
            ]} />
        ) : (
          <PagedTable rows={data.costByAccount} rowKey={(r) => r.accountId} searchable
            empty={<p className="text-sm text-slate-500 dark:text-slate-400">{t('cockpit.noPostedCosts')}</p>}
            columns={[
              { key: 'number', header: tCommon('labels.account'), cell: (r) => <span className="font-mono text-[13px]">{r.number}</span>, search: (r) => r.number ?? '' },
              { key: 'name', header: tCommon('labels.name'), cell: (r) => r.name, search: (r) => r.name },
              { key: 'amount', header: tCommon('labels.amount'), align: 'right', cell: (r) => money(r.amount) },
            ]} />
        )}
      </div>
    </div>
  )
}
