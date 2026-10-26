import type { ComponentType, ReactNode } from 'react'
import { resolveText, resolveValue, type CellSpec, type TableBlock, type Tone } from '@braedonsaunders/appkit-viewspec'
import { cn } from '@openbooks/ui'
import { alignClass, bodyCellClassName, leafOf } from './table-cells'
import { toneClass } from './tone'
import { nestedScope } from './list-scope'
import { VirtualReportRows } from './virtual-report-rows'
import { windowedColumns } from './windowed-rows'

type Primitive<P> = ComponentType<P & { className?: string; children?: ReactNode }>

/** The table element set a table renders with (report or app primitives). */
export interface TablePrimitives {
  Table: Primitive<object>
  TableHeader: Primitive<object>
  TableBody: Primitive<object>
  TableRow: Primitive<object>
  TableHead: Primitive<object>
  TableCell: Primitive<{ colSpan?: number }>
}

/** Renders one spec cell; the server passes its full renderer (widget cells
 *  included) and browser-rendered report sections pass the browser one. */
export type CellComponent = ComponentType<{ spec: CellSpec; scope: unknown }>

/** A spanning summary row (opening / closing / totals). Resolves against the
 *  table's own scope, not a row scope. */
export function SpanRow({
  row,
  scope,
  primitives,
  Cell,
}: {
  row: NonNullable<TableBlock['leading']>[number]
  scope: unknown
  primitives: TablePrimitives
  Cell: CellComponent
}) {
  const { TableRow, TableCell } = primitives
  return (
    <TableRow className={row.className}>
      <TableCell
        colSpan={row.labelColSpan > 1 ? row.labelColSpan : undefined}
        className={row.labelClassName}
      >
        {resolveText(row.label, scope)}
      </TableCell>
      {row.cells.map((entry, index) => {
        // Tone is applied by the container here exactly as it is for body
        // cells; a span row that skipped it would silently drop the negative
        // treatment on a closing balance.
        const leaf = leafOf(entry.cell)
        const tone = toneClass(
          'tone' in leaf
            ? (resolveValue(leaf.tone as never, scope) as Tone | undefined)
            : undefined,
        )
        return (
          <TableCell
            key={index}
            className={
              cn(alignClass(entry.align), entry.className, tone) || undefined
            }
          >
            <Cell spec={entry.cell} scope={scope} />
          </TableCell>
        )
      })}
    </TableRow>
  )
}

/**
 * A spec table's markup: header, leading and trailing span rows, the empty
 * row and the body. `windowed` hands the body rows to the browser, which
 * renders them a window at a time; `head` lets a caller replace a header cell
 * (the server's sortable headers).
 */
export function TableView({
  spec,
  scope,
  rows,
  primitives,
  Cell,
  windowed,
  head,
}: {
  spec: TableBlock
  scope: unknown
  rows: unknown[]
  primitives: TablePrimitives
  Cell: CellComponent
  windowed: boolean
  head?: (column: TableBlock['columns'][number], index: number, label: string) => ReactNode | undefined
}) {
  const { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } = primitives
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {spec.columns.map((column, index) => {
            const label = resolveText(column.header, scope)
            const custom = head?.(column, index, label)
            if (custom !== undefined) return custom
            const headClass =
              cn(alignClass(column.align), column.headerClassName) || undefined
            return (
              <TableHead key={index} className={headClass}>
                {column.srOnlyHeader ? (
                  <span className="sr-only">{label}</span>
                ) : (
                  label
                )}
              </TableHead>
            )
          })}
        </TableRow>
      </TableHeader>
      <TableBody>
        {spec.leading?.map((row, index) => (
          <SpanRow key={`lead-${index}`} row={row} scope={scope} primitives={primitives} Cell={Cell} />
        ))}
        {rows.length === 0 && spec.emptyRow ? (
          <TableRow>
            <TableCell
              colSpan={spec.emptyRow.colSpan}
              className={spec.emptyRow.className}
            >
              {resolveText(spec.emptyRow.text, scope)}
            </TableCell>
          </TableRow>
        ) : null}
        {windowed ? (
          <VirtualReportRows rows={rows} columns={windowedColumns(spec.columns)} rowKey={spec.rowKey} />
        ) : rows.map((row, rowIndex) => {
          // Cells resolve against the row, with the page scope reachable at
          // `$root` for shared constants (placeholder text, labels). One fixed
          // name, not a parent-traversal operator.
          const rowScope = nestedScope(row, scope)
          return (
            <TableRow
              key={String(
                resolveText(spec.rowKey, rowScope) || `row-${rowIndex}`,
              )}
            >
              {spec.columns.map((column, index) => (
                <TableCell key={index} className={bodyCellClassName(column, rowScope)}>
                  <Cell spec={column.cell} scope={rowScope} />
                </TableCell>
              ))}
            </TableRow>
          )
        })}
        {spec.trailing?.map((row, index) => (
          <SpanRow key={`trail-${index}`} row={row} scope={scope} primitives={primitives} Cell={Cell} />
        ))}
      </TableBody>
    </Table>
  )
}
