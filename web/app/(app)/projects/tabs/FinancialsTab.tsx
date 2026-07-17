'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent, cn } from '@openbooks/ui'
import { KpiStrip, type Kpi } from '../../../../components/kpi-strip'
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

  const kpis: Kpi[] = [
    { label: t('labels.contractValue'), value: money(data.contractValue) },
    { label: t('cockpit.costBudget'), value: money(data.costBudget) },
    { label: t('labels.actualCost'), value: money(data.actualCost) },
    { label: t('cockpit.committedCost'), value: money(data.committedCost) },
    { label: t('cockpit.projectedCost'), value: money(data.projectedCost), tone: overBudget ? 'bad' : undefined },
    { label: t('cockpit.remainingBudget'), value: money(data.remainingBudget), tone: data.remainingBudget < 0 ? 'bad' : 'good' },
    { label: t('cockpit.actualRevenue'), value: money(data.actualRevenue) },
    { label: t('cockpit.margin'), value: money(data.margin), tone: data.margin < 0 ? 'bad' : 'good' },
    { label: t('cockpit.unbilled'), value: money(data.unbilledRevenue), tone: data.unbilledRevenue > 0 ? 'good' : undefined },
    {
      label: t('cockpit.percentSpent'),
      value: data.percentSpent == null ? '—' : (data.percentSpent * 100).toFixed(1),
      suffix: data.percentSpent == null ? undefined : '%',
      tone: overBudget ? 'bad' : undefined,
    },
  ]

  const innerTabs = [
    { key: 'category' as const, label: t('cockpit.costByCategory') },
    { key: 'account' as const, label: t('cockpit.costByAccount') },
  ]

  return (
    <div className="space-y-6">
      <KpiStrip items={kpis} />

      {billingMethod === 'fixed_price' && canManage ? (
        <RecognizeRevenue projectId={projectId} recognizedToDate={recognizedToDate} />
      ) : null}

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
        </CardContent>
      </Card>

      {/* Two cost breakdowns — subtabs, never side-by-side (AGENTS.md). */}
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
