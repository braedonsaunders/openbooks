'use client'

import type { ReactNode } from 'react'
import { PagedTable } from './paged-table'
import type { PreparedListSourceKey } from '../lib/list/prepared-sources'
import type { ListTableColumn } from './list-table'

export interface PreparedTableRow {
  id: string
  cells: ReactNode[]
  searchText: string
  className?: string
}

/** Server-rendered cells cross the RSC boundary as nodes, never callbacks,
 * database rows or translators. Filtering and paging use the shared table. */
export function PreparedPagedTable({
  source,
  rows,
  columns,
  empty,
  leading,
  footer,
  toolbarAfter,
  searchable = true,
  contained = false,
  resetPageKey,
}: {
  source: PreparedListSourceKey
  rows: PreparedTableRow[]
  columns: Omit<ListTableColumn<PreparedTableRow>, 'cell' | 'search'>[]
  empty: ReactNode
  leading?: ReactNode
  footer?: ReactNode
  toolbarAfter?: ReactNode
  searchable?: boolean
  contained?: boolean
  resetPageKey?: string
}) {
  return (
    <PagedTable<PreparedTableRow>
      source={source}
      resetPageKey={resetPageKey}
      contained={contained}
      rows={rows}
      rowKey={(row) => row.id}
      columns={columns.map((column, index) => ({
        ...column,
        cell: (row: PreparedTableRow) => row.cells[index],
        search: (row: PreparedTableRow) => row.searchText,
      }))}
      rowClassName={(row) => row.className}
      empty={empty}
      emptyAsRow
      searchable={searchable}
      toolbarAfter={toolbarAfter}
      leading={leading}
      footer={footer}
    />
  )
}
