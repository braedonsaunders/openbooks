import { ROOT_SCOPE_KEY, type TableBlock } from '@braedonsaunders/appkit-viewspec'
import { BROWSER_CELL_WIDGETS } from './browser-cell-widgets'

/** Report tables longer than this render their rows a window at a time. */
export const WINDOWED_ROWS_FROM = 300

const browserWidgetNames = new Set(Object.keys(BROWSER_CELL_WIDGETS))

export type WindowedColumn = Pick<TableBlock['columns'][number], 'cell' | 'align' | 'className'>

/**
 * True when every body cell can render from its own row alone: no `$root`
 * reference (the page scope stays on the server) and no widget that only the
 * server registry can render.
 */
export function rowsRenderInBrowser(spec: TableBlock): boolean {
  const refersToRoot = JSON.stringify([spec.columns.map((column) => column.cell), spec.rowKey ?? null]).includes(`"${ROOT_SCOPE_KEY}`)
  if (refersToRoot) return false
  return spec.columns.every((column) => column.cell.kind !== 'widget' || browserWidgetNames.has(column.cell.widget))
}

/** The part of each column the browser needs to render a body cell. */
export function windowedColumns(columns: TableBlock['columns']): WindowedColumn[] {
  return columns.map(({ cell, align, className }) => ({ cell, align, className }))
}
