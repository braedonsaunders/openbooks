'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import {
  Button,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@openbooks/ui'

export interface PagedColumn<T> {
  key: string
  header: ReactNode
  align?: 'left' | 'right'
  cell: (row: T) => ReactNode
  /** Text used for client-side search matching (optional). */
  search?: (row: T) => string
}

/**
 * A client-side searched + paginated table for data already loaded into the
 * flyout/page (AGENTS.md: ALL tables are paginated). For server-driven lists
 * use RecordListView / EntityListView instead.
 */
export function PagedTable<T>({
  rows,
  columns,
  pageSize = 10,
  searchable = false,
  empty,
  rowKey,
}: {
  rows: T[]
  columns: PagedColumn<T>[]
  pageSize?: number
  searchable?: boolean
  empty: ReactNode
  rowKey: (row: T, index: number) => string
}) {
  const t = useTranslations('common')
  const tp = useTranslations('ui.pagination')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) =>
      columns.some((c) => c.search && c.search(r).toLowerCase().includes(q)),
    )
  }, [rows, query, columns])

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const clamped = Math.min(page, pageCount - 1)
  const start = clamped * pageSize
  const view = filtered.slice(start, start + pageSize)

  if (rows.length === 0) return <>{empty}</>

  return (
    <div className="space-y-3">
      {searchable ? (
        <Input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setPage(0)
          }}
          placeholder={t('actions.search')}
          className="max-w-xs"
        />
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((c) => (
              <TableHead key={c.key} align={c.align === 'right' ? 'right' : undefined} className={c.align === 'right' ? 'text-right' : undefined}>
                {c.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {view.map((row, i) => (
            <TableRow key={rowKey(row, start + i)}>
              {columns.map((c) => (
                <TableCell key={c.key} className={c.align === 'right' ? 'text-right tabular-nums' : undefined}>
                  {c.cell(row)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {filtered.length > pageSize ? (
        <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
          <span>
            {tp.rich('showing', {
              from: start + 1,
              to: Math.min(start + pageSize, filtered.length),
              total: filtered.length,
              strong: (c) => <strong className="font-semibold text-slate-700 dark:text-slate-200">{c}</strong>,
            })}
          </span>
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" disabled={clamped === 0} onClick={() => setPage(clamped - 1)}>
              {tp('prev')}
            </Button>
            <span className="tabular-nums">{tp('pageOf', { page: clamped + 1, pages: pageCount })}</span>
            <Button variant="outline" size="sm" disabled={clamped >= pageCount - 1} onClick={() => setPage(clamped + 1)}>
              {t('actions.next')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
