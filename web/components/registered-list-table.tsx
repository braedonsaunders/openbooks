import type { ReactNode } from 'react'
import {
  preparedListSource,
  type PreparedListSourceKey,
} from '../lib/list/prepared-sources'
import { PreparedPagedTable } from './prepared-paged-table'
import { ServerPagedTable, type ServerPagedColumn } from './server-paged-table'

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
  rowClassName,
  state,
  basePath,
  currentParams = {},
  sort,
  dir,
  sortParamKey,
  dirParamKey,
  pageParamKey,
  searchable = true,
  paging = true,
}: {
  source: PreparedListSourceKey
  rows: T[]
  columns: ServerPagedColumn<T>[]
  rowKey: (row: T, index: number) => string
  empty: ReactNode
  leading?: ReactNode
  footer?: ReactNode
  rowClassName?: (row: T) => string | undefined
  state?: { total: number; page: number; perPage: number }
  basePath?: string
  currentParams?: Record<string, string | string[] | undefined>
  sort?: string
  dir?: 'asc' | 'desc'
  sortParamKey?: string
  dirParamKey?: string
  pageParamKey?: string
  searchable?: boolean
  paging?: boolean
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
        paging={Boolean(state) && paging}
        showPerPage={Boolean(state)}
        leading={leading}
        footer={footer}
        rowClassName={rowClassName}
      />
    )
  }
  return (
    <PreparedPagedTable
      source={source}
      rows={rows.map((row, index) => ({
        id: rowKey(row, index),
        cells: columns.map((column) => column.cell(row)),
        className: rowClassName?.(row),
        searchText: columns
          .map((column) => column.search?.(row) ?? '')
          .join(' '),
      }))}
      columns={columns.map(
        ({ cell: _cell, search: _search, sortKey: _sortKey, ...column }) => {
          void _cell
          void _search
          void _sortKey
          return column
        },
      )}
      empty={empty}
      leading={leading}
      footer={footer}
      searchable={searchable}
    />
  )
}
