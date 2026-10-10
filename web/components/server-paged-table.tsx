import type { ReactNode } from 'react'
import { TableHead } from '@openbooks/ui'
import { ListTable, type ListTableColumn } from './list-table'
import { Pagination } from './pagination'
import { PerPageSelect } from './per-page-select'
import { SortTh } from './sortable-th'
import {
  preparedListSource,
  type PreparedListSourceKey,
} from '../lib/list/prepared-sources'

export interface ServerPagedColumn<T> extends ListTableColumn<T> {
  sortKey?: string
}

/** The same table composition as PagedTable, for a window already paged by
 * its registered server source. Never paginate or filter that window again. */
export function ServerPagedTable<T>({
  rows,
  columns,
  rowKey,
  empty,
  basePath,
  currentParams,
  total,
  page,
  perPage,
  sort,
  dir = 'asc',
  toolbar,
  presentationBody,
  source,
  leading,
  footer,
  rowClassName,
  pageParamKey = 'page',
  perPageParamKey = 'perPage',
  sortParamKey = 'sort',
  dirParamKey = 'dir',
  showPerPage = true,
  paging = true,
  contained = false,
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
  /** Alternative presentation of this exact authorized page, with the same toolbar and pager. */
  presentationBody?: ReactNode
  source?: PreparedListSourceKey
  leading?: ReactNode
  footer?: ReactNode
  rowClassName?: (row: T) => string | undefined
  pageParamKey?: string
  perPageParamKey?: string
  sortParamKey?: string
  dirParamKey?: string
  showPerPage?: boolean
  /** The enclosing source may place its shared pager beside other controls. */
  contained?: boolean
  paging?: boolean
}) {
  if (source && preparedListSource(source).mode === 'loaded') {
    throw new Error('A fully loaded record list must use PagedTable: ' + source)
  }
  return (
    <div className={contained ? 'flex h-full min-h-0 flex-col gap-3' : 'space-y-3'}>
      {toolbar || showPerPage ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {toolbar}
          {showPerPage ? (
            <PerPageSelect
              basePath={basePath}
              currentParams={currentParams}
              perPage={perPage}
              paramKey={perPageParamKey}
              pageParamKey={pageParamKey}
            />
          ) : null}
        </div>
      ) : null}
      <div className={contained ? 'flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900' : 'overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900'}>
        {presentationBody ?? <ListTable
          contained={contained}
          rows={rows}
          columns={columns}
          rowKey={rowKey}
          empty={empty}
          leading={leading}
          footer={footer}
          rowClassName={rowClassName}
          headerCell={(column) => {
            if (column.headerCell !== undefined) return column.headerCell
            const sortKey = columns.find(
              (candidate) => candidate.key === column.key,
            )?.sortKey
            return sortKey && sort ? (
              <SortTh
                key={column.key}
                basePath={basePath}
                currentParams={currentParams}
                column={sortKey}
                sort={sort}
                dir={dir}
                align={column.align === 'right' ? 'right' : 'left'}
                className={column.headerClassName}
                sortParamKey={sortParamKey}
                dirParamKey={dirParamKey}
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
        />}
        {paging ? (
          <Pagination
            basePath={basePath}
            currentParams={currentParams}
            total={total}
            page={page}
            perPage={perPage}
            pageParamKey={pageParamKey}
          />
        ) : null}
      </div>
    </div>
  )
}
