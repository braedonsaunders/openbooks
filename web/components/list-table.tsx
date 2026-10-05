import { Fragment, type CSSProperties, type ReactNode } from 'react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@openbooks/ui'
import { InteractiveTableRow } from './interactive-table-row'

export interface ListTableColumn<T> {
  key: string
  header: ReactNode
  align?: 'left' | 'right' | 'center'
  cell: (row: T) => ReactNode
  search?: (row: T) => string
  className?: string
  headerClassName?: string
  /** A shared sortable header rendered on the server. */
  headerCell?: ReactNode
  style?: CSSProperties
}

/** Shared row rendering for loaded-data and SQL-paginated lists. Pagination
 * and authorization stay with their owning source; cells are composed here. */
export function ListTable<T>({
  rows,
  columns,
  rowKey,
  empty,
  rowClassName,
  onRowClick,
  footer,
  leading,
  headerCell,
  selectionHeader,
  selectionCell,
  rowLabel,
  rowRole,
  rowSelected,
  contained = false,
}: {
  rows: T[]
  columns: ListTableColumn<T>[]
  rowKey: (row: T, index: number) => string
  empty: ReactNode
  rowClassName?: (row: T) => string | undefined
  onRowClick?: (row: T) => void
  footer?: ReactNode
  leading?: ReactNode
  headerCell?: (column: ListTableColumn<T>) => ReactNode
  selectionHeader?: ReactNode
  selectionCell?: (row: T) => ReactNode
  rowLabel?: (row: T) => string
  rowRole?: 'link' | 'button'
  rowSelected?: (row: T) => boolean
  /** Keep scrolling inside the table while its host toolbar stays fixed. */
  contained?: boolean
}) {
  return (
    <Table containerClassName={contained ? 'app-scroll min-h-0 flex-1 overflow-auto' : undefined}>
      <TableHeader>
        <TableRow>
          {selectionHeader}
          {columns.map((column) =>
            headerCell ? (
              headerCell(column)
            ) : column.headerCell !== undefined ? (
              <Fragment key={column.key}>{column.headerCell}</Fragment>
            ) : (
              <TableHead
                key={column.key}
                className={
                  column.headerClassName ??
                  (column.align === 'right'
                    ? 'text-right'
                    : column.align === 'center'
                      ? 'text-center'
                      : column.className)
                }
                style={column.style}
              >
                {column.header}
              </TableHead>
            ),
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {leading}
        {rows.length === 0 ? (
          <TableRow>
            <TableCell
              colSpan={columns.length + (selectionCell ? 1 : 0)}
              className="px-3 py-8 text-center text-slate-500 dark:text-slate-400"
            >
              {empty}
            </TableCell>
          </TableRow>
        ) : (
          rows.map((row, index) => (
            <InteractiveTableRow
              key={rowKey(row, index)}
              aria-label={rowLabel?.(row)}
              role={rowRole}
              data-state={rowSelected?.(row) ? 'selected' : undefined}
              className={
                onRowClick
                  ? `cursor-pointer ${rowClassName?.(row) ?? ''}`
                  : rowClassName?.(row)
              }
              onClick={
                onRowClick
                  ? (event) => {
                      // Buttons, links and inputs retain their own action; opening a
                      // record must not cover an action's result or refusal.
                      const target = event.target as Element | null
                      const action = target?.closest?.(
                        'button, a, input, select, textarea, label, [role="button"], [role="menuitem"], [data-row-action]',
                      )
                      if (action && action !== event.currentTarget) return
                      onRowClick(row)
                    }
                  : undefined
              }
            >
              {selectionCell?.(row)}
              {columns.map((column) => (
                <TableCell
                  key={column.key}
                  className={
                    column.className ??
                    (column.align === 'right'
                      ? 'text-right tabular-nums'
                      : undefined)
                  }
                  style={column.style}
                >
                  {column.cell(row)}
                </TableCell>
              ))}
            </InteractiveTableRow>
          ))
        )}
        {footer}
      </TableBody>
    </Table>
  )
}
