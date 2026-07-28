'use client'

import { useMoney } from '@/components/money-provider'
import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronRight } from 'lucide-react'
import {
  Badge,
  Button,
  Drawer,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from '@openbooks/ui'
import { KpiStrip, type Kpi } from '../../../../components/kpi-strip'
import { PagedTable } from '../../../../components/paged-table'

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
  byItem: TimeRow[]
}

type TimeDimension = 'employee' | 'item' | 'task'

interface TimeEntry {
  id: string
  workedOn: string
  employeeName: string
  itemName: string
  taskName: string
  timeTypeName: string
  hours: string
  billable: boolean
  cost: string
  bill: string
  memo: string | null
  fieldTicketNumber: string | null
}

interface TimeEntryPage {
  entries: TimeEntry[]
  page: number
  pageSize: number
  totalPages: number
  totals: { entries: number; hours: string; cost: string; bill: string }
}

interface DrillTarget {
  dimension: TimeDimension
  key: string | null
  label: string
}

const fmtHours = (v: number) => v.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 4 })

export function CostTimeTab({ data, projectId }: { data: CostTimeData; projectId: string }) {
  const { money } = useMoney()
  const t = useTranslations('projects')
  const tCommon = useTranslations('common')
  const [inner, setInner] = useState<TimeDimension>('employee')
  const [drill, setDrill] = useState<DrillTarget | null>(null)

  const kpis: Kpi[] = [
    { label: t('cockpit.totalHours'), value: fmtHours(data.totals.hours) },
    { label: t('cockpit.billableHours'), value: fmtHours(data.totals.billableHours) },
    { label: t('cockpit.laborCost'), value: money(data.totals.cost) },
    { label: t('cockpit.laborBill'), value: money(data.totals.bill), tone: 'good' },
  ]

  const rows = inner === 'task' ? data.byTask : inner === 'item' ? data.byItem : data.byEmployee
  const unlabeled = inner === 'task'
    ? t('cockpit.unassignedTask')
    : inner === 'item'
      ? t('cockpit.unassignedItem')
      : t('cockpit.unassignedEmployee')
  const labelHead = inner === 'task'
    ? t('labels.task')
    : inner === 'item'
      ? tCommon('labels.item')
      : tCommon('labels.employee')

  const innerTabs = [
    { key: 'employee' as const, label: t('cockpit.timeByEmployee') },
    { key: 'item' as const, label: t('cockpit.timeByItem') },
    { key: 'task' as const, label: t('cockpit.timeByTask') },
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
        <div className="pt-2">
          <PagedTable
            rows={rows}
            rowKey={(r) => r.key ?? 'none'}
            searchable
            empty={<p className="text-sm text-slate-500 dark:text-slate-400">{t('cockpit.noTime')}</p>}
            columns={[
              {
                key: 'label',
                header: labelHead,
                cell: (r) => (
                  <button
                    type="button"
                    onClick={() => setDrill({ dimension: inner, key: r.key, label: r.label || unlabeled })}
                    className={cn(
                      'group flex w-full items-center gap-1.5 text-left font-medium text-teal-700 hover:text-teal-900 dark:text-teal-300 dark:hover:text-teal-100',
                      !r.label && 'text-slate-500 dark:text-slate-400',
                    )}
                  >
                    <span>{r.label || unlabeled}</span>
                    <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
                    <span className="sr-only">{t('cockpit.viewTimeEntries')}</span>
                  </button>
                ),
                search: (r) => r.label,
              },
              { key: 'hours', header: t('cockpit.hoursHead'), align: 'right', cell: (r) => fmtHours(r.hours) },
              { key: 'billable', header: t('cockpit.billableHead'), align: 'right', cell: (r) => fmtHours(r.billableHours) },
              { key: 'cost', header: t('labels.actualCost'), align: 'right', cell: (r) => money(r.cost) },
              { key: 'bill', header: t('cockpit.billValue'), align: 'right', cell: (r) => money(r.bill) },
            ]}
          />
        </div>
      </div>
      {drill ? (
        <TimeEntriesDrawer
          projectId={projectId}
          target={drill}
          onClose={() => setDrill(null)}
        />
      ) : null}
    </div>
  )
}

function TimeEntriesDrawer({
  projectId,
  target,
  onClose,
}: {
  projectId: string
  target: DrillTarget
  onClose: () => void
}) {
  const { money } = useMoney()
  const t = useTranslations('projects')
  const tCommon = useTranslations('common')
  const [page, setPage] = useState(1)
  const [reload, setReload] = useState(0)
  const [data, setData] = useState<TimeEntryPage | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setData(null)
    setError(null)
    const params = new URLSearchParams({
      dimension: target.dimension,
      key: target.key ?? 'unassigned',
      page: String(page),
    })
    fetch(`/api/projects/${encodeURIComponent(projectId)}/time-entries?${params.toString()}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.ok) return response.json()
        const body = await response.json().catch(() => null)
        throw new Error(body?.error || t('cockpit.timeEntriesLoadFailed'))
      })
      .then((body: TimeEntryPage) => setData(body))
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : t('cockpit.timeEntriesLoadFailed'))
        }
      })
    return () => controller.abort()
  }, [page, projectId, reload, t, target.dimension, target.key])

  return (
    <Drawer
      open
      stacked
      size="xl"
      onClose={onClose}
      title={target.label}
      description={t('cockpit.timeEntriesTitle')}
      bodyClassName="overflow-hidden p-0"
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="grid grid-cols-2 gap-x-5 gap-y-2 border-b border-slate-200 bg-slate-50/70 px-5 py-3 text-sm sm:grid-cols-4 dark:border-slate-800 dark:bg-slate-950/40">
          <TimeDetailMetric label={t('cockpit.entriesHead')} value={data ? data.totals.entries.toLocaleString() : '—'} />
          <TimeDetailMetric label={t('cockpit.hoursHead')} value={data ? fmtHours(Number(data.totals.hours)) : '—'} />
          <TimeDetailMetric label={t('labels.actualCost')} value={data ? money(data.totals.cost) : '—'} />
          <TimeDetailMetric label={t('cockpit.billValue')} value={data ? money(data.totals.bill) : '—'} />
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          {error ? (
            <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-center">
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              <Button variant="outline" size="sm" onClick={() => setReload((value) => value + 1)}>
                {tCommon('actions.retry')}
              </Button>
            </div>
          ) : !data ? (
            <p className="py-12 text-center text-sm text-slate-500 dark:text-slate-400">{tCommon('feedback.loading')}</p>
          ) : data.entries.length === 0 ? (
            <p className="py-12 text-center text-sm text-slate-500 dark:text-slate-400">{t('cockpit.noTime')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tCommon('labels.date')}</TableHead>
                  <TableHead>{tCommon('labels.employee')}</TableHead>
                  <TableHead>{tCommon('labels.item')}</TableHead>
                  <TableHead>{t('labels.task')}</TableHead>
                  <TableHead>{t('cockpit.timeTypeHead')}</TableHead>
                  <TableHead>{tCommon('labels.billable')}</TableHead>
                  <TableHead className="text-right" align="right">{t('cockpit.hoursHead')}</TableHead>
                  <TableHead className="text-right" align="right">{t('labels.actualCost')}</TableHead>
                  <TableHead className="text-right" align="right">{t('cockpit.billValue')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.entries.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="min-w-36">
                      <p className="whitespace-nowrap tabular-nums">{entry.workedOn}</p>
                      {entry.memo ? <p className="mt-0.5 max-w-52 truncate text-xs text-slate-500" title={entry.memo}>{entry.memo}</p> : null}
                      {entry.fieldTicketNumber ? <p className="mt-0.5 text-xs text-slate-400">{entry.fieldTicketNumber}</p> : null}
                    </TableCell>
                    <TableCell>{entry.employeeName || '—'}</TableCell>
                    <TableCell>{entry.itemName || '—'}</TableCell>
                    <TableCell>{entry.taskName || '—'}</TableCell>
                    <TableCell>{entry.timeTypeName || '—'}</TableCell>
                    <TableCell>
                      <Badge variant={entry.billable ? 'success' : 'secondary'}>
                        {entry.billable ? tCommon('labels.yes') : tCommon('labels.no')}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmtHours(Number(entry.hours))}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(entry.cost)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(entry.bill)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        {data && data.totalPages > 1 ? (
          <div className="flex items-center justify-between border-t border-slate-200 px-5 py-3 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
            <span>{t('cockpit.timeEntriesPage', { page: data.page, pages: data.totalPages })}</span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>
                {tCommon('actions.previous')}
              </Button>
              <Button variant="outline" size="sm" disabled={data.page >= data.totalPages} onClick={() => setPage(data.page + 1)}>
                {tCommon('actions.next')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </Drawer>
  )
}

function TimeDetailMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</p>
      <p className="mt-0.5 font-semibold tabular-nums text-slate-900 dark:text-slate-100">{value}</p>
    </div>
  )
}
