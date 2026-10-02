'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Search } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button, Input, TableCell, TableHead } from '@openbooks/ui'
import { ListTable, type ListTableColumn } from './list-table'
import {
  preparedListSource,
  type PreparedListSourceKey,
} from '../lib/list/prepared-sources'

export type PagedColumn<T> = ListTableColumn<T>

export interface PagedSelection<T> {
  getId: (row: T) => string
  /** Currently selected ids (array or set). */
  selectedIds: readonly string[] | ReadonlySet<string>
  onToggle: (id: string) => void
  /** Toggle the ids passed. The table always passes the WHOLE filtered set
   *  across all pages — never just the visible page — so a caller
   *  implementing select-all selects (or clears) every search match, and a
   *  caller wanting page-only semantics must narrow the ids itself. */
  onToggleAll: (ids: string[]) => void
  disabled?: boolean
}

const checkboxClass =
  'h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-600 dark:bg-slate-950'

/**
 * A client-side searched + paginated table for data already loaded into the
 * flyout/page. Registered server windows retain the domain reader's rows;
 * RegisteredListTable owns their server pagination controls.
 */
export function PagedTable<T>({
  rows,
  columns,
  pageSize = 10,
  searchable = false,
  empty,
  rowKey,
  rowClassName,
  toolbarAfter,
  toolbarAlign,
  onRowClick,
  footer,
  emptyAsRow,
  selection,
  source,
  leading,
  rowLabel,
  rowRole,
  rowSelected,
}: {
  rows: T[]
  columns: PagedColumn<T>[]
  pageSize?: number
  searchable?: boolean
  empty: ReactNode
  rowKey: (row: T, index: number) => string
  rowClassName?: (row: T) => string | undefined
  /** Controls rendered immediately after the search box on the same toolbar row. */
  toolbarAfter?: ReactNode
  /** Bottom-align search with labelled filter fields in the same row. */
  toolbarAlign?: 'end'
  /** Makes rows interactive (cursor + click), e.g. to open a detail drawer. */
  onRowClick?: (row: T) => void
  /** Extra TableRow(s) rendered after the page's rows (e.g. a totals row).
   *  Computed from ALL rows by the caller, so it holds across pages/search. */
  footer?: ReactNode
  /** Empty composition: render the toolbar plus the table headers with
   *  `empty` as a single spanning row — the SetupEntitySection/departments
   *  composition. Registered lists retain this chrome by default; callers
   *  may explicitly opt into a standalone empty state. */
  emptyAsRow?: boolean
  /** Optional checkbox column with a select-all header over the filtered
   *  rows. Selection state lives with the caller; this only renders it. */
  selection?: PagedSelection<T>
  /** A registered server window is never searched or sliced a second time. */
  source?: PreparedListSourceKey
  leading?: ReactNode
  rowLabel?: (row: T) => string
  rowRole?: 'link' | 'button'
  rowSelected?: (row: T) => boolean
}) {
  const external = source ? preparedListSource(source).mode !== 'loaded' : false
  searchable = searchable && !external
  const t = useTranslations('common')
  const tp = useTranslations('ui.pagination')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (external || !q) return rows
    return rows.filter((r) =>
      columns.some((c) => c.search && c.search(r).toLowerCase().includes(q)),
    )
  }, [rows, query, columns, external])

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const clamped = external ? 0 : Math.min(page, pageCount - 1)
  const start = clamped * pageSize
  const view = external ? filtered : filtered.slice(start, start + pageSize)

  const selected = useMemo(() => {
    if (!selection) return null
    return selection.selectedIds instanceof Set
      ? selection.selectedIds
      : new Set(selection.selectedIds)
  }, [selection])
  const filteredIds = useMemo(
    () => (selection ? filtered.map((row) => selection.getId(row)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered, selection?.getId],
  )
  const allFilteredSelected =
    !!selection &&
    filteredIds.length > 0 &&
    filteredIds.every((id) => selected?.has(id))
  const someFilteredSelected =
    !!selection &&
    filteredIds.some((id) => selected?.has(id)) &&
    !allFilteredSelected
  const selectAllRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (selectAllRef.current)
      selectAllRef.current.indeterminate = someFilteredSelected
  }, [someFilteredSelected])

  const toolbar = searchable ? (
    toolbarAfter ? (
      <div className={`flex flex-wrap gap-2${toolbarAlign === 'end' ? ' items-end' : ''}`}>
        <div className="relative min-w-56 flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-slate-400"
            size={15}
          />
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setPage(0)
            }}
            aria-label={t('actions.search')}
            placeholder={t('actions.search')}
            className="pl-8"
          />
        </div>
        {toolbarAfter}
      </div>
    ) : (
      <Input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setPage(0)
        }}
        aria-label={t('actions.search')}
        placeholder={t('actions.search')}
        className="max-w-xs"
      />
    )
  ) : toolbarAfter ?? null

  if (rows.length === 0) {
    if (!(emptyAsRow ?? Boolean(source))) return <>{empty}</>
    return (
      <div className="space-y-3">
        {toolbar}
        <ListTable rows={[]} columns={columns} rowKey={rowKey} empty={empty} leading={leading} footer={footer} />
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {toolbar}
      <ListTable
        rows={view}
        columns={columns}
        rowKey={(row, index) => rowKey(row, start + index)}
        empty={empty}
        rowClassName={rowClassName}
        onRowClick={onRowClick}
        footer={footer}
        leading={leading}
        rowLabel={rowLabel}
        rowRole={rowRole}
        rowSelected={rowSelected}
        selectionHeader={
          selection ? (
            <TableHead className="w-10">
              <span className="sr-only">{tp('selectAllMatching')}</span>
              <input
                ref={selectAllRef}
                type="checkbox"
                className={checkboxClass}
                checked={allFilteredSelected}
                disabled={selection.disabled || filteredIds.length === 0}
                onChange={() => selection.onToggleAll(filteredIds)}
              />
            </TableHead>
          ) : undefined
        }
        selectionCell={
          selection
            ? (row) => (
                <TableCell>
                  <input
                    type="checkbox"
                    className={checkboxClass}
                    checked={selected?.has(selection.getId(row)) ?? false}
                    disabled={selection.disabled}
                    onChange={() => selection.onToggle(selection.getId(row))}
                    onClick={(event) => event.stopPropagation()}
                  />
                </TableCell>
              )
            : undefined
        }
      />
      {!external && filtered.length > pageSize ? (
        <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
          <span>
            {tp.rich('showing', {
              from: start + 1,
              to: Math.min(start + pageSize, filtered.length),
              total: filtered.length,
              strong: (c) => (
                <strong className="font-semibold text-slate-700 dark:text-slate-200">
                  {c}
                </strong>
              ),
            })}
          </span>
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              disabled={clamped === 0}
              onClick={() => setPage(clamped - 1)}
            >
              {tp('prev')}
            </Button>
            <span className="tabular-nums">
              {tp('pageOf', { page: clamped + 1, pages: pageCount })}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={clamped >= pageCount - 1}
              onClick={() => setPage(clamped + 1)}
            >
              {t('actions.next')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
