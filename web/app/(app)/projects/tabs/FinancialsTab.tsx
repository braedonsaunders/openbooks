'use client'

import { useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent, cn } from '@openbooks/ui'
import { PagedTable } from '../../../../components/paged-table'
import { money } from '../../../../lib/format'
import { RecognizeRevenue } from './RecognizeButton'

interface CategoryRow { category: string; amount: number }
interface AccountRow { accountId: string; number: string | null; name: string; amount: number }

export interface FinancialsData {
  contractValue: number
  costBudget: number
  actualCost: number
  committedCost: number
  projectedCost: number
  remainingBudget: number
  actualRevenue: number
  margin: number
  unbilledRevenue: number
  percentSpent: number | null
  costByCategory: CategoryRow[]
  costByAccount: AccountRow[]
}

/** One line of the P&L statement. */
function Line({
  label,
  hint,
  value,
  variant = 'plain',
  tone,
}: {
  label: string
  hint?: string
  value: ReactNode
  variant?: 'plain' | 'subtotal' | 'total'
  tone?: 'good' | 'bad'
}) {
  return (
    <div
      className={cn(
        'flex items-baseline justify-between gap-4 px-4 py-2',
        variant === 'subtotal' && 'bg-slate-50/60 dark:bg-slate-800/40',
        variant === 'total' && 'bg-slate-50 dark:bg-slate-800/60',
      )}
    >
      <div className="min-w-0">
        <div
          className={cn(
            'text-sm',
            variant === 'plain' ? 'text-slate-600 dark:text-slate-300' : 'font-semibold text-slate-900 dark:text-slate-100',
            variant === 'total' && 'text-base',
          )}
        >
          {label}
        </div>
        {hint ? <div className="text-xs text-slate-400 dark:text-slate-500">{hint}</div> : null}
      </div>
      <div
        className={cn(
          'shrink-0 tabular-nums',
          variant === 'plain' ? 'text-sm text-slate-700 dark:text-slate-200' : 'font-semibold text-slate-900 dark:text-slate-100',
          variant === 'total' && 'text-lg',
          tone === 'good' && '!text-teal-700 dark:!text-teal-300',
          tone === 'bad' && '!text-red-600 dark:!text-red-400',
        )}
      >
        {value}
      </div>
    </div>
  )
}

export function FinancialsTab({
  data,
  projectId,
  billingMethod,
  recognizedToDate,
  canManage,
}: {
  data: FinancialsData
  projectId: string
  billingMethod: string | null
  recognizedToDate: string
  canManage: boolean
}) {
  const t = useTranslations('projects')
  const tCommon = useTranslations('common')
  const [inner, setInner] = useState<'category' | 'account'>('category')

  const scale = Math.max(data.costBudget, data.projectedCost, 1)
  const actualPct = Math.min(100, (data.actualCost / scale) * 100)
  const committedPct = Math.min(100 - actualPct, (data.committedCost / scale) * 100)
  const budgetMarkerPct = Math.min(100, (data.costBudget / scale) * 100)
  const overBudget = data.projectedCost > data.costBudget && data.costBudget > 0

  const grossProfit = data.contractValue - data.projectedCost
  const marginPct = data.contractValue > 0 ? (grossProfit / data.contractValue) * 100 : null
  const remainingPct = data.costBudget > 0 ? (data.remainingBudget / data.costBudget) * 100 : null
  const pnlTone = (v: number): 'good' | 'bad' | undefined => (v > 0 ? 'good' : v < 0 ? 'bad' : undefined)

  const innerTabs = [
    { key: 'category' as const, label: t('cockpit.costByCategory') },
    { key: 'account' as const, label: t('cockpit.costByAccount') },
  ]

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Mini P&L statement */}
        <Card>
          <CardContent className="p-0">
            <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('cockpit.pnlTitle')}</h2>
            </div>
            <div className="divide-y divide-slate-100 dark:divide-slate-800/60">
              <Line label={t('cockpit.invoicedToDate')} hint={t('cockpit.invoicedHint')} value={money(data.actualRevenue)} />
              <Line label={t('cockpit.couldBeInvoiced')} hint={t('cockpit.couldBeInvoicedHint')} value={money(data.unbilledRevenue)} tone={data.unbilledRevenue > 0 ? 'good' : undefined} />
              <Line label={t('cockpit.totalJobPrice')} value={money(data.contractValue)} variant="subtotal" />

              <Line label={t('labels.actualCost')} value={money(data.actualCost)} />
              <Line label={t('cockpit.committedCost')} hint={t('cockpit.committedHint')} value={money(data.committedCost)} />
              <Line label={t('cockpit.totalJobCost')} value={money(data.projectedCost)} variant="subtotal" tone={overBudget ? 'bad' : undefined} />

              <Line label={t('cockpit.costBudget')} value={money(data.costBudget)} />
              <Line
                label={t('cockpit.remainingBudget')}
                value={
                  <span>
                    {money(data.remainingBudget)}
                    {remainingPct != null ? <span className="ml-1 text-xs font-normal text-slate-400"> ({remainingPct.toFixed(1)}%)</span> : null}
                  </span>
                }
                tone={data.remainingBudget < 0 ? 'bad' : undefined}
              />

              <Line
                label={t('cockpit.grossProfit')}
                value={
                  <span>
                    {money(grossProfit)}
                    {marginPct != null ? <span className="ml-1.5 text-sm font-normal text-slate-400"> {marginPct.toFixed(1)}%</span> : null}
                  </span>
                }
                variant="total"
                tone={pnlTone(grossProfit)}
              />
            </div>
          </CardContent>
        </Card>

        {/* Budget bar */}
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('cockpit.budgetBarTitle')}</h2>
              <span className={cn('text-sm font-medium tabular-nums', overBudget ? 'text-red-600 dark:text-red-400' : 'text-teal-700 dark:text-teal-300')}>
                {overBudget
                  ? t('cockpit.overBudget', { amount: money(data.projectedCost - data.costBudget) })
                  : data.costBudget > 0
                    ? t('cockpit.underBudget', { amount: money(data.costBudget - data.projectedCost) })
                    : t('cockpit.noCostBudget')}
              </span>
            </div>
            <div className="relative h-6 w-full overflow-hidden rounded-md bg-slate-100 dark:bg-slate-800">
              <div className="absolute inset-y-0 left-0 bg-teal-500" style={{ width: `${actualPct}%` }} title={t('cockpit.actualAmount', { amount: money(data.actualCost) })} />
              <div className="absolute inset-y-0 bg-amber-400" style={{ left: `${actualPct}%`, width: `${committedPct}%` }} title={t('cockpit.committedAmount', { amount: money(data.committedCost) })} />
              {data.costBudget > 0 ? (
                <div className="absolute inset-y-0 w-0.5 bg-slate-900 dark:bg-white" style={{ left: `${budgetMarkerPct}%` }} title={t('cockpit.costBudgetAmount', { amount: money(data.costBudget) })} />
              ) : null}
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
              <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-teal-500" /> {t('cockpit.actualAmount', { amount: money(data.actualCost) })}</span>
              <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-amber-400" /> {t('cockpit.committedAmount', { amount: money(data.committedCost) })}</span>
              <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-0.5 bg-slate-900 dark:bg-white" /> {t('cockpit.costBudgetAmount', { amount: money(data.costBudget) })}</span>
            </div>
            {data.percentSpent != null ? (
              <div className="pt-1 text-xs text-slate-500 dark:text-slate-400">
                {t('cockpit.percentSpent')}: <span className="font-medium tabular-nums text-slate-700 dark:text-slate-200">{(data.percentSpent * 100).toFixed(1)}%</span>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      {billingMethod === 'fixed_price' && canManage ? (
        <RecognizeRevenue projectId={projectId} recognizedToDate={recognizedToDate} />
      ) : null}

      {/* Cost breakdown — subtabs, never side-by-side (AGENTS.md). */}
      <div className="space-y-3">
        <nav className="-mb-px flex gap-1 border-b border-slate-200 dark:border-slate-800" aria-label={t('cockpit.costBreakdownAria')}>
          {innerTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setInner(tab.key)}
              aria-selected={inner === tab.key}
              className={cn(
                'border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                inner === tab.key
                  ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300'
                  : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200',
              )}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        {inner === 'category' ? (
          <PagedTable
            rows={data.costByCategory}
            rowKey={(r) => r.category}
            empty={<p className="text-sm text-slate-500 dark:text-slate-400">{t('cockpit.noPostedCosts')}</p>}
            columns={[
              { key: 'category', header: t('cockpit.category'), cell: (r) => (r.category === 'cogs' || r.category === 'operating_expense' ? t(`cockpit.categories.${r.category}`) : r.category) },
              { key: 'amount', header: tCommon('labels.amount'), align: 'right', cell: (r) => money(r.amount) },
            ]}
          />
        ) : (
          <PagedTable
            rows={data.costByAccount}
            rowKey={(r) => r.accountId}
            searchable
            empty={<p className="text-sm text-slate-500 dark:text-slate-400">{t('cockpit.noPostedCosts')}</p>}
            columns={[
              { key: 'number', header: tCommon('labels.account'), cell: (r) => <span className="font-mono text-[13px]">{r.number}</span>, search: (r) => r.number ?? '' },
              { key: 'name', header: tCommon('labels.name'), cell: (r) => r.name, search: (r) => r.name },
              { key: 'amount', header: tCommon('labels.amount'), align: 'right', cell: (r) => money(r.amount) },
            ]}
          />
        )}
      </div>
    </div>
  )
}
