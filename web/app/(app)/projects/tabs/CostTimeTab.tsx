'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { cn } from '@openbooks/ui'
import { KpiStrip, type Kpi } from '../../../../components/kpi-strip'
import { PagedTable } from '../../../../components/paged-table'
import { money } from '../../../../lib/format'

interface TimeRow {
  key: string | null
  label: string
  hours: number
  billableHours: number
  cost: string
  bill: string
}

export interface CostTimeData {
  totals: { hours: number; billableHours: number; cost: string; bill: string }
  byTask: TimeRow[]
  byEmployee: TimeRow[]
}

const fmtHours = (v: number) => v.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })

export function CostTimeTab({ data }: { data: CostTimeData }) {
  const t = useTranslations('projects')
  const tCommon = useTranslations('common')
  const [inner, setInner] = useState<'task' | 'employee'>('task')

  const kpis: Kpi[] = [
    { label: t('cockpit.totalHours'), value: fmtHours(data.totals.hours) },
    { label: t('cockpit.billableHours'), value: fmtHours(data.totals.billableHours) },
    { label: t('cockpit.laborCost'), value: money(data.totals.cost) },
    { label: t('cockpit.laborBill'), value: money(data.totals.bill), tone: 'good' },
  ]

  const rows = inner === 'task' ? data.byTask : data.byEmployee
  const unlabeled = inner === 'task' ? t('cockpit.unassignedTask') : t('cockpit.unassignedEmployee')
  const labelHead = inner === 'task' ? t('labels.task') : tCommon('labels.employee')

  const innerTabs = [
    { key: 'task' as const, label: t('cockpit.timeByTask') },
    { key: 'employee' as const, label: t('cockpit.timeByEmployee') },
  ]

  return (
    <div className="space-y-6">
      <KpiStrip items={kpis} />
      <div className="space-y-3">
        <nav className="-mb-px flex gap-1 border-b border-slate-200 dark:border-slate-800" aria-label={t('cockpit.timeBreakdownAria')}>
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
        <PagedTable
          rows={rows}
          rowKey={(r) => r.key ?? 'none'}
          searchable
          empty={<p className="text-sm text-slate-500 dark:text-slate-400">{t('cockpit.noTime')}</p>}
          columns={[
            { key: 'label', header: labelHead, cell: (r) => <span className={r.label ? 'font-medium' : 'text-slate-400'}>{r.label || unlabeled}</span>, search: (r) => r.label },
            { key: 'hours', header: t('cockpit.hoursHead'), align: 'right', cell: (r) => fmtHours(r.hours) },
            { key: 'billable', header: t('cockpit.billableHead'), align: 'right', cell: (r) => fmtHours(r.billableHours) },
            { key: 'cost', header: t('labels.actualCost'), align: 'right', cell: (r) => money(r.cost) },
            { key: 'bill', header: t('cockpit.billValue'), align: 'right', cell: (r) => money(r.bill) },
          ]}
        />
      </div>
    </div>
  )
}
