import type { ReactNode } from 'react'
import {
  preparedListSource,
  type PreparedListSourceKey,
} from '../lib/list/prepared-sources'
import { compareDecimal } from '../lib/exact-decimal'
import { SortTh } from './sortable-th'
import { PreparedPagedTable } from './prepared-paged-table'
import { ServerPagedTable, type ServerPagedColumn } from './server-paged-table'

export interface RegisteredListColumn<T> extends ServerPagedColumn<T> {
  /** Raw values, independent of localized cell formatting. */
  sortValue?: (row: T) => string | number | bigint | null | undefined
  sortType?: 'decimal'
}

/** Adapt an authorized domain reader to the same registered table composition
 * as the platform users list. Cell slots retain each domain's actions and
 * formatting; the shared components own table chrome and pagination. */
export function RegisteredListTable<T>({
  source,
  rows,
  columns,
  rowKey,
  empty,
  leading,
  footer,
  toolbarAfter,
  rowClassName,
  state,
  basePath,
  currentParams = {},
  sort,
  dir,
  sortParamKey,
  dirParamKey,
  pageParamKey,
  perPageParamKey,
  searchable = true,
  paging = true,
  showPerPage,
  contained = false,
  resetPageKey,
}: {
  source: PreparedListSourceKey
  rows: T[]
  columns: RegisteredListColumn<T>[]
  rowKey: (row: T, index: number) => string
  empty: ReactNode
  leading?: ReactNode
  footer?: ReactNode
  toolbarAfter?: ReactNode
  rowClassName?: (row: T) => string | undefined
  state?: { total: number; page: number; perPage: number }
  basePath?: string
  currentParams?: Record<string, string | string[] | undefined>
  sort?: string
  dir?: 'asc' | 'desc'
  sortParamKey?: string
  dirParamKey?: string
  pageParamKey?: string
  perPageParamKey?: string
  searchable?: boolean
  paging?: boolean
  showPerPage?: boolean
  contained?: boolean
  /** Domain filter changes restart paging while retaining the search query. */
  resetPageKey?: string
}) {
  const definition = preparedListSource(source)
  const ids = rows.map(rowKey)
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new Error(
      'Record list rows require unique stable identities: ' + source,
    )
  }
  if (definition.mode !== 'loaded') {
    if (definition.mode === 'server' && !state)
      throw new Error('Missing server pagination for record list: ' + source)
    return (
      <ServerPagedTable
        contained={contained}
        source={source}
        rows={rows}
        columns={columns}
        rowKey={rowKey}
        empty={empty}
        total={state?.total ?? 0}
        page={state?.page ?? 1}
        perPage={state?.perPage ?? 25}
        basePath={basePath ?? definition.route}
        currentParams={currentParams}
        sort={sort}
        dir={dir}
        sortParamKey={sortParamKey}
        dirParamKey={dirParamKey}
        pageParamKey={pageParamKey}
        perPageParamKey={perPageParamKey}
        paging={Boolean(state) && paging}
        showPerPage={showPerPage ?? definition.showPerPage ?? Boolean(state)}
        toolbar={toolbarAfter}
        leading={leading}
        footer={footer}
        rowClassName={rowClassName}
      />
    )
  }
  const activeColumn = columns.find((column) => column.sortKey === sort && column.sortValue)
  const ordered = activeColumn ? [...rows].sort((a, b) => {
    const left = activeColumn.sortValue!(a)
    const right = activeColumn.sortValue!(b)
    // Unconfigured values remain last in either direction.
    if (left == null || right == null) return left == null && right == null ? 0 : left == null ? 1 : -1
    const compared = activeColumn.sortType === 'decimal'
      ? compareDecimal(String(left), String(right))
      : typeof left === 'number' && typeof right === 'number' || typeof left === 'bigint' && typeof right === 'bigint'
        ? left < right ? -1 : left > right ? 1 : 0
        : String(left).localeCompare(String(right))
    return compared * (dir === 'desc' ? -1 : 1)
  }) : rows
  return (
    <PreparedPagedTable
      source={source}
      contained={contained}
      resetPageKey={`${sort ?? ''}:${dir ?? 'asc'}:${resetPageKey ?? ''}`}
      rows={ordered.map((row, index) => ({
        id: rowKey(row, index),
        cells: columns.map((column) => column.cell(row)),
        className: rowClassName?.(row),
        searchText: columns
          .map((column) => column.search?.(row) ?? '')
          .join(' '),
      }))}
      columns={columns.map(
        ({ cell: _cell, search: _search, sortValue: _sortValue, sortType: _sortType, sortKey, ...column }) => {
          void _cell
          void _search
          void _sortValue
          void _sortType
          return {
            ...column,
            headerCell: column.headerCell ?? (sortKey && sort ? (
              <SortTh basePath={basePath ?? definition.route} currentParams={currentParams}
                column={sortKey} sort={sort} dir={dir ?? 'asc'}
                align={column.align === 'right' ? 'right' : 'left'}
                className={column.headerClassName} sortParamKey={sortParamKey}
                dirParamKey={dirParamKey} pageParamKey={pageParamKey}>
                {column.header}
              </SortTh>
            ) : undefined),
          }
        },
      )}
      empty={empty}
      leading={leading}
      footer={footer}
      searchable={searchable}
      toolbarAfter={toolbarAfter}
    />
  )
}
