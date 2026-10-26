import type { ReactNode } from 'react'
import { PagedTable, type PagedColumn } from './paged-table'
import type { PreparedListSourceKey } from '../lib/list/prepared-sources'

/** @deprecated Use PagedColumn. */
export type ServerPagedColumn<T> = PagedColumn<T>

/** @deprecated Render PagedTable with `serverWindow`. */
export function ServerPagedTable<T>({
  toolbar,
  total,
  page,
  perPage,
  ...props
}: {
  rows: T[]
  columns: PagedColumn<T>[]
  rowKey: (row: T, index: number) => string
  empty: ReactNode
  basePath: string
  currentParams: Record<string, string | string[] | undefined>
  total: number
  page: number
  perPage: number
  sort?: string
  dir?: 'asc' | 'desc'
  toolbar?: ReactNode
  source?: PreparedListSourceKey
  leading?: ReactNode
  footer?: ReactNode
  rowClassName?: (row: T) => string | undefined
  pageParamKey?: string
  perPageParamKey?: string
  sortParamKey?: string
  dirParamKey?: string
  showPerPage?: boolean
  contained?: boolean
  paging?: boolean
}) {
  return <PagedTable {...props} toolbarAfter={toolbar} serverWindow={{ total, page, perPage }} />
}
