'use client'

import type { ReactNode } from 'react'
import { Clock, FileText, Briefcase, TrendingUp, Receipt } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Badge } from '@openbooks/ui'
import { useMoney } from '@/components/money-provider'
import { RegisteredListTable } from '@/components/registered-list-table'
import type { CustomerPulseTimelineItem, CustomerPulseTimelinePage } from '@/lib/customer-pulse-timeline-params'

/** The reader supplies one server window; the table never re-slices it. */
export function PulseHistoryTable({ rows, currency, state, toolbar, withheld = false }: {
  rows: CustomerPulseTimelineItem[]
  currency: string
  state: Pick<CustomerPulseTimelinePage, 'total' | 'page' | 'perPage'>
  toolbar?: ReactNode
  withheld?: boolean
}) {
  const t = useTranslations('crm.pulse')
  const tc = useTranslations('common')
  const { money } = useMoney(currency)
  const statusLabel = (value: string) => tc.has(`status.${value}` as never)
    ? tc(`status.${value}` as never) : value.replace(/_/g, ' ')
  return <RegisteredListTable
    source="customer_pulse_history"
    rows={rows}
    state={state}
    rowKey={(item) => `${item.type}:${item.id}`}
    searchable={false}
    showPerPage={false}
    paging={false}
    toolbarAfter={toolbar}
    empty={<div className="py-8 text-center text-xs text-slate-400">{withheld ? t('restrictedNotice') : t('timelineEmpty')}</div>}
    columns={[
      { key: 'description', header: tc('labels.description'), cell: (item) => {
        const Icon = item.type === 'activity' ? Clock : item.type === 'estimate' ? Briefcase
          : item.type === 'sales_order' ? TrendingUp : item.type === 'payment' ? Receipt : FileText
        const color = item.type === 'activity' ? 'text-indigo-500' : item.type === 'estimate' ? 'text-amber-500'
          : item.type === 'sales_order' ? 'text-cyan-500' : item.type === 'payment' ? 'text-emerald-500' : 'text-rose-500'
        return <div className="flex min-w-0 items-start gap-2.5"><Icon aria-hidden="true" className={`mt-0.5 h-4 w-4 shrink-0 ${color}`} /><div><div className="font-semibold text-slate-900 dark:text-slate-100">{item.title}</div>{item.description && <p className="mt-0.5 line-clamp-1 text-xs text-slate-500">{item.description}</p>}</div></div>
      } },
      { key: 'amount', header: tc('labels.amount'), align: 'right', cell: (item) => item.amount !== undefined
        ? <span className="font-semibold tabular-nums">{money(item.amount, { currency: item.currency ?? currency })}</span> : '—' },
      { key: 'status', header: tc('labels.status'), cell: (item) => item.status
        ? <Badge variant="secondary" className="text-[10px]">{statusLabel(item.status)}</Badge> : '—' },
      { key: 'date', header: tc('labels.date'), cell: (item) => <span className="whitespace-nowrap text-xs text-slate-500">{item.timestamp.slice(0, 10)}</span> },
    ]}
  />
}
