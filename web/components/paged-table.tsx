import type { ReactNode } from 'react'
import { TableHead } from '@openbooks/ui'
import { compareDecimal } from '../lib/exact-decimal'
import {
  preparedListSource,
  type PreparedListSource,
  type PreparedListSourceKey,
} from '../lib/list/prepared-sources'
import { ListTable, type ListTableColumn } from './list-table'
import { ClientPagedTable, PreparedPagedRows } from './paged-table-client'
import { Pagination } from './pagination'
import { PerPageSelect } from './per-page-select'
import { SortTh } from './sortable-th'

export interface PagedColumn<T> extends ListTableColumn<T> {
  /** The URL sort key this column's header links to. */
  sortKey?: string
  /** Raw values that order a loaded list, independent of localized cell formatting. */
  sortValue?: (row: T) => string | number | bigint | null | undefined
  sortType?: 'decimal'
}

/**
 * Page and search kept in the URL: the server reads them for the first
 * paint and the table writes them back with replaceState as they change, so
 * a reload or a shared link reopens the same page and search. `page` is
 * one-based, as it reads in the address bar.
 */
export interface PagedUrlState {
  pageKey: string
  page: number
  searchKey?: string
  query?: string
}

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

/** The counts of one page read by the server, for the shared pager. */
export interface PagedServerPage {
  total: number
  page: number
  perPage: number
}

type PagedComposition =
  | {
      /**
       * Render every row's cells here and hand the browser only the
       * rendered cells and search text. Required when a server component
       * renders the list: callbacks and reader rows never cross to the
       * browser, and each row needs a unique stable identity.
       */
      prepared: true
      source: PreparedListSourceKey
    }
  | {
      prepared?: false
      /** A registered window that is not loaded is never searched or sliced again. */
      source?: PreparedListSourceKey
    }

export type PagedTableProps<T> = PagedComposition & {
  rows: T[]
  columns: PagedColumn<T>[]
  rowKey: (row: T, index: number) => string
  empty: ReactNode
  /**
   * The filtered-empty state: shown instead of `empty` when the search, or
   * a filter the caller applied (`filtersActive`), leaves no rows. `empty`
   * teaches the genuinely-empty list; this says nothing matches.
   */
  emptyFiltered?: ReactNode
  /** The caller's own filters narrowed `rows` (beyond this table's search). */
  filtersActive?: boolean
  pageSize?: number
  searchable?: boolean
  /** Row-level search text, replacing the per-column search texts. */
  searchText?: (row: T) => string
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
  leading?: ReactNode
  /** Collection coverage belongs beside paging, outside the record rows. */
  paginationNote?: ReactNode
  /** Empty composition: render the toolbar plus the table headers with
   *  `empty` as a single spanning row — the SetupEntitySection/departments
   *  composition. Registered lists retain this chrome by default; callers
   *  may explicitly opt into a standalone empty state. */
  emptyAsRow?: boolean
  /** The spanning empty row under the headers; a host that renders its own
   *  empty state turns it off. */
  emptyRow?: boolean
  /** Optional checkbox column with a select-all header over the filtered
   *  rows. Selection state lives with the caller; this only renders it. */
  selection?: PagedSelection<T>
  rowLabel?: (row: T) => string
  rowRole?: 'link' | 'button'
  rowSelected?: (row: T) => boolean
  /** Only actionable rows receive click and keyboard-open behavior. */
  rowInteractive?: (row: T) => boolean
  /** Keep scrolling inside the table while its host toolbar stays fixed. */
  contained?: boolean
  /** Sorting and filter changes restart paging without discarding the search query. */
  resetPageKey?: string
  /** Inside a record drawer the search stretches across the drawer, the
   *  drawer sublist composition; list pages keep the capped page search. */
  searchLayout?: 'list' | 'drawer'
  urlState?: PagedUrlState
  /**
   * The rows are one window the server read, sorted and paged through the
   * URL: a framed table with the shared pager and page-size selector. Pass
   * `true` for a window whose source owns no page count.
   */
  serverWindow?: PagedServerPage | true
  /** A server window inside a host that owns the surrounding frame. */
  framed?: boolean
  /** URL of the sort links and pager; a registered source's route by default. */
  basePath?: string
  currentParams?: Record<string, string | string[] | undefined>
  /** The URL sort: headers of columns with a `sortKey` link to it, and a
   *  loaded list orders its rows by the active column's `sortValue`. */
  sort?: string
  dir?: 'asc' | 'desc'
  sortParamKey?: string
  dirParamKey?: string
  pageParamKey?: string
  perPageParamKey?: string
  showPerPage?: boolean
  /** A server window may leave its pager to the enclosing source. */
  paging?: boolean
}

/**
 * The one list for records that are not documents. Loaded rows are searched
 * and paged in the browser; a registered window the server read keeps the
 * reader's rows and its URL pager. Cells are slots, so each domain keeps its
 * own actions and formatting while this owns the table chrome.
 */
export function PagedTable<T>(props: PagedTableProps<T>) {
  const definition = props.source ? preparedListSource(props.source) : undefined
  if (props.prepared) {
    const ids = props.rows.map(props.rowKey)
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
      throw new Error('Record list rows require unique stable identities: ' + props.source)
    }
  }
  if (props.serverWindow) return serverWindowTable(props, definition)
  if (props.prepared && definition?.mode === 'server') {
    throw new Error('Missing server pagination for record list: ' + props.source)
  }
  const loaded = !definition || definition.mode === 'loaded'
  const rows = loaded ? orderedRows(props) : props.rows
  const columns = props.sort === undefined ? props.columns : sortableColumns(props, definition)
  const resetPageKey = props.prepared || props.sort !== undefined
    ? `${props.sort ?? ''}:${props.dir ?? 'asc'}:${props.resetPageKey ?? ''}`
    : props.resetPageKey
  if (props.prepared) {
    const cellClasses = columns.some((column) => column.cellClassName)
    return (
      <PreparedPagedRows
        source={props.source}
        contained={props.contained}
        resetPageKey={resetPageKey}
        rows={rows.map((row, index) => ({
          id: props.rowKey(row, index),
          cells: columns.map((column) => column.cell(row)),
          className: props.rowClassName?.(row),
          cellClassNames: cellClasses ? columns.map((column) => column.cellClassName?.(row)) : undefined,
          searchText: props.searchText
            ? props.searchText(row)
            : columns.map((column) => column.search?.(row) ?? '').join(' '),
        }))}
        columns={columns.map(
          ({ cell: _cell, search: _search, cellClassName: _cellClassName, sortValue: _sortValue, sortType: _sortType, sortKey: _sortKey, ...column }) => {
            void _cell
            void _search
            void _cellClassName
            void _sortValue
            void _sortType
            void _sortKey
            return column
          },
        )}
        empty={props.empty}
        emptyFiltered={props.emptyFiltered}
        filtersActive={props.filtersActive}
        emptyAsRow={props.emptyAsRow}
        emptyRow={props.emptyRow}
        leading={props.leading}
        footer={props.footer}
        paginationNote={props.paginationNote}
        searchable={props.searchable}
        searchLayout={props.searchLayout}
        pageSize={props.pageSize}
        toolbarAfter={props.toolbarAfter}
        toolbarAlign={props.toolbarAlign}
        urlState={props.urlState}
      />
    )
  }
  return (
    <ClientPagedTable
      rows={rows}
      columns={columns}
      rowKey={props.rowKey}
      empty={props.empty}
      emptyFiltered={props.emptyFiltered}
      filtersActive={props.filtersActive}
      pageSize={props.pageSize}
      searchable={props.searchable}
      searchText={props.searchText}
      rowClassName={props.rowClassName}
      toolbarAfter={props.toolbarAfter}
      toolbarAlign={props.toolbarAlign}
      onRowClick={props.onRowClick}
      footer={props.footer}
      leading={props.leading}
      paginationNote={props.paginationNote}
      emptyAsRow={props.emptyAsRow}
      emptyRow={props.emptyRow}
      selection={props.selection}
      source={props.source}
      rowLabel={props.rowLabel}
      rowRole={props.rowRole}
      rowSelected={props.rowSelected}
      rowInteractive={props.rowInteractive}
      contained={props.contained}
      resetPageKey={resetPageKey}
      searchLayout={props.searchLayout}
      urlState={props.urlState}
    />
  )
}

function sortBasePath<T>(props: PagedTableProps<T>, definition: PreparedListSource | undefined): string {
  const basePath = props.basePath ?? definition?.route
  if (!basePath) throw new Error('A URL-sorted or server-paged list needs its base path')
  return basePath
}

/** A loaded list follows the URL sort through the active column's raw values. */
function orderedRows<T>(props: PagedTableProps<T>): T[] {
  const active = props.columns.find((column) => column.sortKey === props.sort && column.sortValue)
  const sortValue = active?.sortValue
  if (!active || !sortValue) return props.rows
  return [...props.rows].sort((a, b) => {
    const left = sortValue(a)
    const right = sortValue(b)
    // Unconfigured values remain last in either direction.
    if (left == null || right == null) return left == null && right == null ? 0 : left == null ? 1 : -1
    const compared = active.sortType === 'decimal'
      ? compareDecimal(String(left), String(right))
      : typeof left === 'number' && typeof right === 'number' || typeof left === 'bigint' && typeof right === 'bigint'
        ? left < right ? -1 : left > right ? 1 : 0
        : String(left).localeCompare(String(right))
    return compared * (props.dir === 'desc' ? -1 : 1)
  })
}

function sortableColumns<T>(props: PagedTableProps<T>, definition: PreparedListSource | undefined): PagedColumn<T>[] {
  return props.columns.map((column) => ({
    ...column,
    headerCell: column.headerCell ?? (column.sortKey && props.sort ? (
      <SortTh basePath={sortBasePath(props, definition)} currentParams={props.currentParams ?? {}}
        column={column.sortKey} sort={props.sort} dir={props.dir ?? 'asc'}
        align={column.align === 'right' ? 'right' : 'left'}
        className={column.headerClassName} sortParamKey={props.sortParamKey}
        dirParamKey={props.dirParamKey} pageParamKey={props.pageParamKey}>
        {column.header}
      </SortTh>
    ) : undefined),
  }))
}

/** A window already paged by its server source: never paginated or filtered again. */
function serverWindowTable<T>(props: PagedTableProps<T>, definition: PreparedListSource | undefined) {
  if (definition?.mode === 'loaded') {
    throw new Error('A fully loaded record list is paged in the browser, not as a server window: ' + props.source)
  }
  const counts = props.serverWindow === true ? undefined : props.serverWindow
  if (definition?.mode === 'server' && !counts) {
    throw new Error('Missing server pagination for record list: ' + props.source)
  }
  const basePath = sortBasePath(props, definition)
  const currentParams = props.currentParams ?? {}
  const pageParamKey = props.pageParamKey ?? 'page'
  const perPage = counts?.perPage ?? 25
  const showPerPage = props.showPerPage ?? definition?.showPerPage ?? Boolean(counts)
  const contained = props.contained ?? false
  const columns = props.columns
  const table = (
    <ListTable
      contained={contained}
      rows={props.rows}
      columns={columns}
      rowKey={props.rowKey}
      empty={props.filtersActive && props.emptyFiltered !== undefined ? props.emptyFiltered : props.empty}
      emptyRow={props.emptyRow}
      leading={props.leading}
      footer={props.footer}
      rowClassName={props.rowClassName}
      onRowClick={props.onRowClick}
      rowLabel={props.rowLabel}
      rowRole={props.rowRole}
      rowSelected={props.rowSelected}
      rowInteractive={props.rowInteractive}
      headerCell={(column) => {
        if (column.headerCell !== undefined) return column.headerCell
        const sortKey = columns.find(
          (candidate) => candidate.key === column.key,
        )?.sortKey
        return sortKey && props.sort ? (
          <SortTh
            key={column.key}
            basePath={basePath}
            currentParams={currentParams}
            column={sortKey}
            sort={props.sort}
            dir={props.dir ?? 'asc'}
            align={column.align === 'right' ? 'right' : 'left'}
            className={column.headerClassName}
            sortParamKey={props.sortParamKey}
            dirParamKey={props.dirParamKey}
            pageParamKey={pageParamKey}
          >
            {column.header}
          </SortTh>
        ) : (
          <TableHead
            key={column.key}
            className={
              column.headerClassName ??
              (column.align === 'right'
                ? 'text-right'
                : column.align === 'center'
                  ? 'text-center'
                  : undefined)
            }
            style={column.style}
          >
            {column.header}
          </TableHead>
        )
      }}
    />
  )
  const pager = counts && (props.paging ?? true) ? (
    <Pagination
      basePath={basePath}
      currentParams={currentParams}
      total={counts.total}
      page={counts.page}
      perPage={perPage}
      pageParamKey={pageParamKey}
    />
  ) : null
  return (
    <div className={contained ? 'flex h-full min-h-0 flex-col gap-3' : 'space-y-3'}>
      {props.toolbarAfter || showPerPage ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {props.toolbarAfter}
          {showPerPage ? (
            <PerPageSelect
              basePath={basePath}
              currentParams={currentParams}
              perPage={perPage}
              paramKey={props.perPageParamKey ?? 'perPage'}
              pageParamKey={pageParamKey}
            />
          ) : null}
        </div>
      ) : null}
      {props.framed === false ? (
        <>
          {table}
          {pager}
        </>
      ) : (
        <div className={contained ? 'flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900' : 'overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900'}>
          {table}
          {pager}
        </div>
      )}
    </div>
  )
}
