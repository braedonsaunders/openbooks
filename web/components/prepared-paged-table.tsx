'use client'

import type { ReactNode } from 'react'
import { PagedTable, type PagedColumn, type PagedUrlState } from './paged-table'
import type { PreparedTableRow } from './paged-table-client'
import type { PreparedListSourceKey } from '../lib/list/prepared-sources'

export type { PreparedTableRow } from './paged-table-client'

/** @deprecated Render PagedTable with `prepared`. */
export function PreparedPagedTable({
  source,
  rows,
  columns,
  empty,
  emptyFiltered,
  filtersActive,
  leading,
  footer,
  paginationNote,
  toolbarAfter,
  searchable = true,
  contained = false,
  resetPageKey,
  urlState,
}: {
  source: PreparedListSourceKey
  rows: PreparedTableRow[]
  columns: Omit<PagedColumn<PreparedTableRow>, 'cell' | 'search'>[]
  empty: ReactNode
  emptyFiltered?: ReactNode
  filtersActive?: boolean
  leading?: ReactNode
  footer?: ReactNode
  paginationNote?: ReactNode
  toolbarAfter?: ReactNode
  searchable?: boolean
  contained?: boolean
  resetPageKey?: string
  urlState?: PagedUrlState
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
      emptyFiltered={emptyFiltered}
      filtersActive={filtersActive}
      emptyAsRow
      searchable={searchable}
      toolbarAfter={toolbarAfter}
      leading={leading}
      footer={footer}
      paginationNote={paginationNote}
      urlState={urlState}
    />
  )
}
