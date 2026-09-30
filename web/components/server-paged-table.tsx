import type { ReactNode } from 'react'
import { TableHead } from '@openbooks/ui'
import { ListTable, type ListTableColumn } from './list-table'
import { Pagination } from './pagination'
import { PerPageSelect } from './per-page-select'
import { SortTh } from './sortable-th'

export interface ServerPagedColumn<T> extends ListTableColumn<T> {
  sortKey?: string
}

/** The same table composition as PagedTable, for a window already paged by
 * its registered server source. Never paginate or filter that window again. */
export function ServerPagedTable<T>({ rows, columns, rowKey, empty, basePath,
  currentParams, total, page, perPage, sort, dir = 'asc', toolbar,
}: {
  rows: T[]
  columns: ServerPagedColumn<T>[]
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
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {toolbar}
        <PerPageSelect basePath={basePath} currentParams={currentParams} perPage={perPage} />
      </div>
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <ListTable rows={rows} columns={columns} rowKey={rowKey} empty={empty}
          headerCell={(column) => {
            const sortKey = columns.find((candidate) => candidate.key === column.key)?.sortKey
            return sortKey && sort ? (
              <SortTh key={column.key} basePath={basePath} currentParams={currentParams} column={sortKey} sort={sort} dir={dir} align={column.align}>{column.header}</SortTh>
            ) : <TableHead key={column.key} className={column.className} style={column.style}>{column.header}</TableHead>
          }}
        />
        <Pagination basePath={basePath} currentParams={currentParams} total={total} page={page} perPage={perPage} />
      </div>
    </div>
  )
}
