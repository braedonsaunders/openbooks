'use client'

/** Split from PartyDrawer.tsx (ARCH-FILE-SPLIT; pure moves only). */
import { type PartyPayload, field } from './party-drawer-model'
import { useMoney } from '@/components/money-provider'
import { useMemo, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { useViewerFormat } from '@/lib/viewer-format'
import { CalendarDays, CircleDollarSign, FileText, Search } from 'lucide-react'
import { Button, Input, Label, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import type { LineGridColumn } from '../../../components/line-grid'
import { ReadOnlyValue } from '../../../components/read-only-value'

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
      value: primaryCurrency ? money(primaryCurrency.openBalance, { currency: primaryCurrency.currency }) : t('summary.multipleCurrencies'),
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

export function SublistHeading({ title, description, icon }: { title: string; description: string; icon: React.ReactNode }) {
  return (
    <div>
      <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">{icon}{title}</h3>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{description}</p>
    </div>
  )
}

export function SublistEmpty({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex min-h-36 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 text-slate-400 dark:border-slate-700 dark:text-slate-500">
      {icon}<p className="text-sm">{text}</p>
    </div>
  )
}

export function ReadOnlyLineSublist<Row extends Record<string, unknown>>({
  columns,
  rows,
  searchPlaceholder,
  onEdit,
}: {
  columns: LineGridColumn<Row>[]
  rows: Row[]
  searchPlaceholder: string
  onEdit?: (row: Row, index: number) => void
}) {
  const tc = useTranslations('common')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const perPage = 10
  const filtered = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase()
    if (!needle) return rows
    return rows.filter((row) => columns.some((column) => String(row[column.key] ?? '').toLocaleLowerCase().includes(needle)))
  }, [columns, q, rows])
  const pages = Math.max(1, Math.ceil(filtered.length / perPage))
  const shown = filtered.slice((page - 1) * perPage, page * perPage)
  return (
    <div className="space-y-3">
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-slate-400" size={15} />
        <Input value={q} onChange={(event) => { setQ(event.target.value); setPage(1) }} placeholder={searchPlaceholder} className="pl-8" />
      </div>
      {shown.length ? (
        <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
          <Table>
            <TableHeader>
              <TableRow>
                {columns.map((column) => <TableHead key={String(column.key)}>{column.label}</TableHead>)}
                {onEdit ? <TableHead className="text-right">{tc('labels.actions')}</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((row, shownIndex) => (
                <TableRow key={String(row.id ?? `${page}-${shownIndex}`)}>
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
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>{tc('actions.previous')}</Button>
        <span className="text-xs tabular-nums text-slate-500">{page} / {pages}</span>
        <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>{tc('actions.next')}</Button>
      </div>
    </div>
  )
}
