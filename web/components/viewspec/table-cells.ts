import { resolveValue, type TableBlock, type Tone } from '@braedonsaunders/appkit-viewspec'
import { cn } from '@openbooks/ui'
import { toneClass } from './tone'

type ColumnSpec = TableBlock['columns'][number]

/** Column alignment → the exact classes the native tables use. */
export function alignClass(align: 'left' | 'right' | 'center' | undefined): string {
  if (align === 'right') return 'text-right'
  if (align === 'center') return 'text-center'
  return ''
}

export function leafOf(cell: ColumnSpec['cell']) {
  // Every wrapper kind must be unwrapped here. Adding one and forgetting this
  // helper is how a converted cell silently loses its alignment or tone.
  return cell.kind === 'drill' || cell.kind === 'txn' ? cell.inner : cell
}

/**
 * Money and number columns carry `tabular-nums` on the cell, matching the
 * native pages. Doing it here rather than in the cell renderer keeps the
 * figure alignment attached to the column, which is where it belongs.
 */
export function isNumericCell(cell: ColumnSpec['cell']): boolean {
  const leaf = leafOf(cell)
  return leaf.kind === 'money' || leaf.kind === 'number'
}

/** The body cell's classes for one row. Only the value-bearing renderers carry
 *  a tone; date/badge/link cells own their own presentation. */
export function bodyCellClassName(column: Pick<ColumnSpec, 'cell' | 'align' | 'className'>, rowScope: unknown): string | undefined {
  const leaf = leafOf(column.cell)
  const tone = toneClass('tone' in leaf ? (resolveValue(leaf.tone as never, rowScope) as Tone | undefined) : undefined)
  return cn(alignClass(column.align), isNumericCell(column.cell) && 'tabular-nums', tone, column.className) || undefined
}
