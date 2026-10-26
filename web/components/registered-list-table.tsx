import type { ReactNode } from 'react'
import {
  preparedListSource,
  type PreparedListSourceKey,
} from '../lib/list/prepared-sources'
import { PagedTable, type PagedColumn, type PagedServerPage, type PagedUrlState } from './paged-table'

/** @deprecated Use PagedColumn. */
export type RegisteredListColumn<T> = PagedColumn<T>

/** @deprecated Render PagedTable with `prepared`, and `serverWindow` for a source that is not loaded. */
export function RegisteredListTable<T>({
  source,
  state,
  searchable = true,
  paging = true,
  currentParams = {},
  ...props
}: {
  source: PreparedListSourceKey
  rows: T[]
  columns: PagedColumn<T>[]
  rowKey: (row: T, index: number) => string
  empty: ReactNode
  emptyFiltered?: ReactNode
  filtersActive?: boolean
  leading?: ReactNode
  footer?: ReactNode
  toolbarAfter?: ReactNode
  rowClassName?: (row: T) => string | undefined
  state?: PagedServerPage
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
  resetPageKey?: string
  urlState?: PagedUrlState
}) {
  return (
    <PagedTable
      {...props}
      prepared
      source={source}
      searchable={searchable}
      paging={paging}
      currentParams={currentParams}
      serverWindow={preparedListSource(source).mode === 'loaded' ? undefined : (state ?? true)}
    />
  )
}
