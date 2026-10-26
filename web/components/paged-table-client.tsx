'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Search } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button, Input, TableCell, TableHead } from '@openbooks/ui'
import { ListTable } from './list-table'
import { LIST_SEARCH_WIDTH } from './list-search-layout'
import {
  preparedListSource,
  type PreparedListSourceKey,
} from '../lib/list/prepared-sources'
import type { PagedColumn, PagedSelection, PagedUrlState } from './paged-table'

const checkboxClass =
  'h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-600 dark:bg-slate-950'

/**
 * PagedTable's browser body: client-side search and paging over rows already
 * loaded into the page or drawer. A registered window that is not loaded is
 * shown as read, never searched or sliced again.
 */
export function ClientPagedTable<T>({
  rows,
  columns,
  pageSize = 10,
  searchable = false,
  searchText,
  empty,
  emptyFiltered,
  filtersActive = false,
  rowKey,
  rowClassName,
  toolbarAfter,
  toolbarAlign,
  onRowClick,
  footer,
  paginationNote,
  emptyAsRow,
  emptyRow,
  selection,
  source,
  leading,
  rowLabel,
  rowRole,
  rowSelected,
  rowInteractive,
  contained = false,
  resetPageKey,
  searchLayout = 'list',
  urlState,
}: {
  rows: T[]
  columns: PagedColumn<T>[]
  pageSize?: number
  searchable?: boolean
  /** Row-level search text, replacing the per-column search texts. */
  searchText?: (row: T) => string
  empty: ReactNode
  /**
   * The filtered-empty state: shown instead of `empty` when the search, or
   * a filter the caller applied (`filtersActive`), leaves no rows. `empty`
   * teaches the genuinely-empty list; this says nothing matches.
   */
  emptyFiltered?: ReactNode
  /** The caller's own filters narrowed `rows` (beyond this table's search). */
  filtersActive?: boolean
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
  /** Collection coverage belongs beside paging, outside the record rows. */
  paginationNote?: ReactNode
  /** Empty composition: render the toolbar plus the table headers with
   *  `empty` as a single spanning row — the SetupEntitySection/departments
   *  composition. Registered lists retain this chrome by default; callers
   *  may explicitly opt into a standalone empty state. */
  emptyAsRow?: boolean
  emptyRow?: boolean
  /** Optional checkbox column with a select-all header over the filtered
   *  rows. Selection state lives with the caller; this only renders it. */
  selection?: PagedSelection<T>
  /** A registered server window is never searched or sliced a second time. */
  source?: PreparedListSourceKey
  leading?: ReactNode
  rowLabel?: (row: T) => string
  rowRole?: 'link' | 'button'
  rowSelected?: (row: T) => boolean
  /** Only actionable rows receive click and keyboard-open behavior. */
  rowInteractive?: (row: T) => boolean
  contained?: boolean
  /** Sorting changes restart paging without discarding the search query. */
  resetPageKey?: string
  /** Inside a record drawer the search stretches across the drawer, the
   *  drawer sublist composition; list pages keep the capped page search. */
  searchLayout?: 'list' | 'drawer'
  urlState?: PagedUrlState
}) {
  const external = source ? preparedListSource(source).mode !== 'loaded' : false
  searchable = searchable && !external
  const t = useTranslations('common')
  const tp = useTranslations('ui.pagination')
  const [query, setQuery] = useState(urlState?.searchKey ? urlState.query ?? '' : '')
  const [page, setPage] = useState(urlState ? Math.max(0, Math.trunc(urlState.page) - 1) : 0)
  // Sorting changes restart paging: reset during render when the key moves.
  const [pageKey, setPageKey] = useState(resetPageKey)
  if (pageKey !== resetPageKey) {
    setPageKey(resetPageKey)
    setPage(0)
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (external || !q) return rows
    return rows.filter((r) =>
      searchText
        ? searchText(r).toLowerCase().includes(q)
        : columns.some((c) => c.search && c.search(r).toLowerCase().includes(q)),
    )
  }, [rows, query, columns, external, searchText])

  const narrowed = filtersActive || (!external && query.trim() !== '')
  const emptyState = narrowed ? emptyFiltered ?? t('empty.description') : empty
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const clamped = external ? 0 : Math.min(page, pageCount - 1)
  const start = clamped * pageSize
  const view = external ? filtered : filtered.slice(start, start + pageSize)

  const urlPageKey = urlState?.pageKey
  const urlSearchKey = urlState?.searchKey
  useEffect(() => {
    if (!urlPageKey || external) return
    const url = new URL(window.location.href)
    const write = (key: string, value: string | null) => (value ? url.searchParams.set(key, value) : url.searchParams.delete(key))
    write(urlPageKey, clamped > 0 ? String(clamped + 1) : null)
    if (urlSearchKey) write(urlSearchKey, query.trim() ? query : null)
    const next = `${url.pathname}${url.search}${url.hash}`
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState(window.history.state, '', next)
    }
  }, [urlPageKey, urlSearchKey, clamped, query, external])

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
    searchLayout === 'drawer' ? (
      <div className={`flex w-full flex-wrap gap-2${toolbarAlign === 'end' ? ' items-end' : ''}`} data-sublist-toolbar="">
        <div className="relative min-w-56 flex-1" data-sublist-search="">
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
            className="w-full pl-8"
          />
        </div>
        {toolbarAfter}
      </div>
    ) : toolbarAfter ? (
      <div className={`flex flex-wrap gap-2${toolbarAlign === 'end' ? ' items-end' : ''}`}>
        {/* The search keeps its own height when the controls beside it wrap,
            so the icon stays centred in the input. */}
        <div className={`relative ${LIST_SEARCH_WIDTH}${toolbarAlign === 'end' ? '' : ' self-start'}`}>
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
        className={LIST_SEARCH_WIDTH}
      />
    )
  ) : toolbarAfter ?? null

  if (rows.length === 0) {
    if (!(emptyAsRow ?? Boolean(source))) return <>{emptyState}</>
    return (
      <div className={contained ? 'flex h-full min-h-0 flex-col gap-3' : 'space-y-3'}>
        {toolbar && contained ? <div className="shrink-0">{toolbar}</div> : toolbar}
        <ListTable rows={[]} columns={columns} rowKey={rowKey} empty={emptyState} emptyRow={emptyRow} leading={leading} footer={footer} contained={contained} />
      </div>
    )
  }

  return (
    <div className={contained ? 'flex h-full min-h-0 flex-col gap-3' : 'space-y-3'}>
      {toolbar && contained ? <div className="shrink-0">{toolbar}</div> : toolbar}
      <ListTable
        rows={view}
        contained={contained}
        columns={columns}
        rowKey={(row, index) => rowKey(row, start + index)}
        empty={emptyState}
        emptyRow={emptyRow}
        rowClassName={rowClassName}
        onRowClick={onRowClick}
        footer={footer}
        leading={leading}
        rowLabel={rowLabel}
        rowRole={rowRole}
        rowSelected={rowSelected}
        rowInteractive={rowInteractive}
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
                    aria-label={`${t('actions.select')} ${rowLabel?.(row) ?? selection.getId(row)}`}
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
      {!external && filtered.length > 0 ? (
        <div className="flex shrink-0 items-center justify-between text-xs text-slate-500 dark:text-slate-400">
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
          {filtered.length > pageSize ? <div className="flex items-center gap-1.5">
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
          </div> : null}
        </div>
      ) : null}
      {paginationNote ? <p className="text-xs text-slate-500 dark:text-slate-400">{paginationNote}</p> : null}
    </div>
  )
}

/** A row whose cells were rendered where the table was composed. */
export interface PreparedTableRow {
  id: string
  cells: ReactNode[]
  searchText: string
  className?: string
  /** Per-cell classes, in column order, for columns whose tone follows the value. */
  cellClassNames?: (string | undefined)[]
}

/** Prepared cells cross the server boundary as nodes, never callbacks,
 * reader rows or translators; search and paging use the browser body. */
export function PreparedPagedRows({
  source,
  rows,
  columns,
  empty,
  emptyFiltered,
  filtersActive,
  emptyAsRow,
  emptyRow,
  leading,
  footer,
  paginationNote,
  toolbarAfter,
  toolbarAlign,
  searchable,
  searchLayout,
  pageSize,
  contained = false,
  resetPageKey,
  urlState,
}: {
  source: PreparedListSourceKey
  rows: PreparedTableRow[]
  columns: Omit<PagedColumn<PreparedTableRow>, 'cell' | 'search' | 'cellClassName'>[]
  empty: ReactNode
  emptyFiltered?: ReactNode
  filtersActive?: boolean
  emptyAsRow?: boolean
  emptyRow?: boolean
  leading?: ReactNode
  footer?: ReactNode
  paginationNote?: ReactNode
  toolbarAfter?: ReactNode
  toolbarAlign?: 'end'
  searchable?: boolean
  searchLayout?: 'list' | 'drawer'
  pageSize?: number
  contained?: boolean
  resetPageKey?: string
  urlState?: PagedUrlState
}) {
  return (
    <ClientPagedTable<PreparedTableRow>
      source={source}
      resetPageKey={resetPageKey}
      contained={contained}
      rows={rows}
      rowKey={(row) => row.id}
      columns={columns.map((column, index) => ({
        ...column,
        cell: (row: PreparedTableRow) => row.cells[index],
        cellClassName: (row: PreparedTableRow) => row.cellClassNames?.[index],
        search: (row: PreparedTableRow) => row.searchText,
      }))}
      rowClassName={(row) => row.className}
      empty={empty}
      emptyFiltered={emptyFiltered}
      filtersActive={filtersActive}
      emptyAsRow={emptyAsRow}
      emptyRow={emptyRow}
      searchable={searchable}
      searchLayout={searchLayout}
      pageSize={pageSize}
      toolbarAfter={toolbarAfter}
      toolbarAlign={toolbarAlign}
      leading={leading}
      footer={footer}
      paginationNote={paginationNote}
      urlState={urlState}
    />
  )
}
