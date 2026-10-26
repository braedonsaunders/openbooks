import { ROOT_SCOPE_KEY, resolvePath, type Block, type TableBlock } from '@braedonsaunders/appkit-viewspec'
import { BROWSER_BLOCK_WIDGETS, BROWSER_CELL_WIDGETS } from './browser-widgets'

/** Report tables longer than this render their rows a window at a time. */
export const WINDOWED_ROWS_FROM = 300

const browserWidgetNames = new Set(Object.keys(BROWSER_CELL_WIDGETS))
const browserBlockWidgetNames = new Set(Object.keys(BROWSER_BLOCK_WIDGETS))

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

/** One section of a grouped report as the browser receives it: the section's
 *  key, the slice of its scope its headings and span rows read, and the rows
 *  of each table block (indexed like the section's blocks). */
export interface WindowedGroup {
  key: string
  scope: Record<string, unknown>
  rows: unknown[][]
}

/**
 * True when a repeated report section consists only of headings and report
 * tables the browser can render: browser-safe heading widgets and report
 * tables whose rows render from the row alone.
 */
export function sectionsRenderInBrowser(blocks: readonly Block[]): boolean {
  return blocks.length > 0 && blocks.every((block) => {
    if ('when' in block && block.when) return false
    if (block.kind === 'widget') return browserBlockWidgetNames.has(block.widget)
    if (block.kind !== 'table') return false
    if (block.variant !== 'report' || block.sorting) return false
    if (block.empty && !block.emptyRow && !block.leading && !block.trailing) return false
    return rowsRenderInBrowser(block)
  })
}

/** Everything a section reads from its own scope, rows excluded: heading
 *  props, column headers, span rows and the empty row. */
export function sectionScopeSpecs(blocks: readonly Block[]): unknown[] {
  return blocks.map((block) => block.kind === 'widget'
    ? block.props ?? {}
    : block.kind === 'table'
      ? [block.columns.map((column) => column.header), block.leading ?? [], block.trailing ?? [], block.emptyRow ?? null]
      : null)
}

/**
 * A copy of `scope` holding only the paths the specs reference, at the same
 * paths, so the browser resolves them exactly as the server would without
 * receiving the rest of the page.
 */
export function pickScope(specs: unknown, scope: unknown): Record<string, unknown> {
  const picked: Record<string, unknown> = {}
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    if (!node || typeof node !== 'object') return
    const ref = (node as { $?: unknown }).$
    if (typeof ref === 'string' && Object.keys(node).length === 1) {
      const value = resolvePath(scope, ref)
      if (value === undefined) return
      const parts = ref.split('.')
      let target = picked
      for (const part of parts.slice(0, -1)) {
        const next = target[part]
        target = (next && typeof next === 'object' ? next : (target[part] = {})) as Record<string, unknown>
      }
      target[parts[parts.length - 1]!] = value
      return
    }
    Object.values(node).forEach(visit)
  }
  visit(specs)
  return picked
}
