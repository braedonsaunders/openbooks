import type { CSSProperties, ReactNode } from 'react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { InteractiveTableRow } from './interactive-table-row'

export interface ListTableColumn<T> {
  key: string
  header: ReactNode
  align?: 'left' | 'right'
  cell: (row: T) => ReactNode
  search?: (row: T) => string
  className?: string
  style?: CSSProperties
}

/** Shared row rendering for loaded-data and SQL-paginated lists. Pagination
 * and authorization stay with their owning source; cells are composed here. */
export function ListTable<T>({ rows, columns, rowKey, empty, rowClassName,
  onRowClick, footer, headerCell, selectionHeader, selectionCell,
}: {
  rows: T[]
  columns: ListTableColumn<T>[]
  rowKey: (row: T, index: number) => string
  empty: ReactNode
  rowClassName?: (row: T) => string | undefined
  onRowClick?: (row: T) => void
  footer?: ReactNode
  headerCell?: (column: ListTableColumn<T>) => ReactNode
  selectionHeader?: ReactNode
  selectionCell?: (row: T) => ReactNode
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {selectionHeader}
          {columns.map((column) => headerCell ? headerCell(column) : (
            <TableHead key={column.key} className={column.align === 'right' ? 'text-right' : column.className} style={column.style}>
              {column.header}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow><TableCell colSpan={columns.length + (selectionCell ? 1 : 0)} className="px-3 py-8 text-center text-slate-500 dark:text-slate-400">{empty}</TableCell></TableRow>
        ) : rows.map((row, index) => (
          <InteractiveTableRow
            key={rowKey(row, index)}
            className={onRowClick ? `cursor-pointer ${rowClassName?.(row) ?? ''}` : rowClassName?.(row)}
            onClick={onRowClick ? (event) => {
              // Buttons, links and inputs retain their own action; opening a
              // record must not cover an action's result or refusal.
              const target = event.target as Element | null
              if (target?.closest?.('button, a, input, select, textarea, label, [role="button"], [role="menuitem"], [data-row-action]')) return
              onRowClick(row)
            } : undefined}
          >
            {selectionCell?.(row)}
            {columns.map((column) => (
              <TableCell key={column.key} className={column.className ?? (column.align === 'right' ? 'text-right tabular-nums' : undefined)} style={column.style}>
                {column.cell(row)}
              </TableCell>
            ))}
          </InteractiveTableRow>
        ))}
        {footer}
      </TableBody>
    </Table>
  )
}
