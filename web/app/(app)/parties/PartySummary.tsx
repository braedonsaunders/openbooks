'use client'

/** Split from PartyDrawer.tsx; moved without behavior changes. */
import { type PartyPayload, field } from './party-drawer-model'
import { useMoney } from '@/components/money-provider'
import { useCallback, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { useViewerFormat } from '@/lib/viewer-format'
import { CalendarDays, CircleDollarSign, FileText } from 'lucide-react'
import { Button, Label, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import type { LineGridColumn } from '../../../components/line-grid'
import { ReadOnlyValue } from '../../../components/read-only-value'
import { DrawerSublist, SublistEmpty, SublistPager, useSublistRows } from '../../../components/drawer-sublist'

export function PartyReadOnlyField({
  label,
  value,
  className,
}: {
  label: ReactNode
  value: ReactNode
  className?: string
}) {
  return (
    <div className={field}>
      <Label>{label}</Label>
      <ReadOnlyValue value={value} className={className} />
    </div>
  )
}

export function PartySummary({ payload }: { payload: PartyPayload }) {
  const { date } = useViewerFormat()
  const { money } = useMoney()
  const t = useTranslations('parties.drawer')
  const summary = payload.transactionSummary
  const primaryCurrency = summary.currencies.length === 1 ? summary.currencies[0] : null
  const cards = [
    { label: t('summary.transactions'), value: String(summary.count), icon: <FileText size={17} /> },
    { label: t('summary.openTransactions'), value: String(summary.openCount), icon: <CircleDollarSign size={17} /> },
    {
      label: t('summary.openBalance'),
      // No currencies means no transactions yet, not several currencies.
      value: primaryCurrency
        ? money(primaryCurrency.openBalance, { currency: primaryCurrency.currency })
        : summary.currencies.length === 0 ? '—' : t('summary.multipleCurrencies'),
      icon: <CircleDollarSign size={17} />,
    },
    {
      label: t('summary.lastTransaction'),
      value: summary.lastDate ? date(new Date(`${summary.lastDate}T12:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' }) : '—',
      icon: <CalendarDays size={17} />,
    },
  ]
  return (
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => (
        <div key={card.label} className="rounded-lg border border-slate-200 bg-slate-50/60 p-3 dark:border-slate-800 dark:bg-slate-950/30">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
            <span className="text-teal-600 dark:text-teal-400">{card.icon}</span>{card.label}
          </div>
          <p className="mt-2 text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">{card.value}</p>
        </div>
      ))}
    </section>
  )
}

/**
 * A drawer tab over rows the drawer already holds (contacts, addresses):
 * the shared sublist archetype with client-side search and paging.
 */
export function ReadOnlyLineSublist<Row extends Record<string, unknown>>({
  title,
  description,
  icon,
  action,
  emptyText,
  columns,
  rows,
  searchPlaceholder,
  onEdit,
}: {
  title: string
  description?: ReactNode
  icon?: ReactNode
  action?: ReactNode
  emptyText: string
  columns: LineGridColumn<Row>[]
  rows: Row[]
  searchPlaceholder: string
  onEdit?: (row: Row, index: number) => void
}) {
  const tc = useTranslations('common')
  const text = useCallback(
    (row: Row) => columns.map((column) => String(row[column.key] ?? '')).join(' '),
    [columns],
  )
  const list = useSublistRows(rows, text)
  return (
    <DrawerSublist
      title={title}
      description={description}
      icon={icon}
      action={action}
      search={rows.length ? { value: list.query, onChange: list.setQuery, placeholder: searchPlaceholder } : undefined}
      footer={rows.length ? <SublistPager page={list.page} pages={list.pages} onPage={list.setPage} /> : null}
    >
      {rows.length === 0 ? (
        <SublistEmpty icon={icon} text={emptyText} />
      ) : list.shown.length ? (
        <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
          <Table>
            <TableHeader>
              <TableRow>
                {columns.map((column) => <TableHead key={String(column.key)}>{column.label}</TableHead>)}
                {onEdit ? <TableHead className="text-right">{tc('labels.actions')}</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.shown.map((row, shownIndex) => (
                <TableRow key={String(row.id ?? `${list.page}-${shownIndex}`)}>
                  {columns.map((column) => {
                    const value = String(row[column.key] ?? '')
                    const option = column.options?.find((item) => item.value === value)
                    return <TableCell key={String(column.key)}>{option?.label ?? (value || '—')}</TableCell>
                  })}
                  {onEdit ? (
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => onEdit(row, rows.indexOf(row))}>{tc('actions.edit')}</Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">{tc('feedback.noResults')}</p>
      )}
    </DrawerSublist>
  )
}
