'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { resolveText, type CellSpec, type TableBlock } from '@braedonsaunders/appkit-viewspec'
import { TableCell, TableRow } from '../../app/(app)/reports/ReportTable'
import { InlineCellView } from './cell-leaves'
import { BROWSER_CELL_WIDGETS } from './browser-widgets'
import { bodyCellClassName } from './table-cells'
import { resolveWidgetProps, type WidgetRenderer } from './widget-props'
import type { WindowedColumn } from './windowed-rows'

/** Rows the server renders before the browser measures anything. */
const FIRST_WINDOW = 60
/** Rows kept rendered above and below the viewport while scrolling. */
const OVERSCAN = 40
/** Report rows are one line of statement type until measured. */
const ESTIMATED_ROW_PX = 33

export function BrowserCell({ spec, scope }: { spec: CellSpec; scope: unknown }) {
  if (spec.kind === 'widget') {
    const render = (BROWSER_CELL_WIDGETS as Record<string, WidgetRenderer | undefined>)[spec.widget]
    return render ? <>{render(resolveWidgetProps(spec.props ?? {}, scope), scope)}</> : null
  }
  return <InlineCellView spec={spec} scope={scope} />
}

function scrollContainer(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return node
  }
  return null
}

/**
 * The body rows of a long report table, rendered a window at a time around
 * the viewport. Spacer rows hold the full table height so the scrollbar and
 * the totals below keep their place; printing renders every row.
 */
export function VirtualReportRows({
  rows,
  columns,
  rowKey,
}: {
  rows: unknown[]
  columns: WindowedColumn[]
  rowKey?: TableBlock['rowKey']
}) {
  const topSpacer = useRef<HTMLTableRowElement>(null)
  const bottomSpacer = useRef<HTMLTableRowElement>(null)
  const rowPx = useRef(ESTIMATED_ROW_PX)
  const [range, setRange] = useState({ start: 0, end: Math.min(rows.length, FIRST_WINDOW) })
  const [printing, setPrinting] = useState(false)

  const update = useCallback(() => {
    const top = topSpacer.current
    const bottom = bottomSpacer.current
    if (!top || !bottom) return
    const container = scrollContainer(top)
    const viewTop = container ? container.getBoundingClientRect().top : 0
    const viewHeight = container ? container.clientHeight : window.innerHeight
    setRange((current) => {
      // The rendered rows sit between the spacers; their span is the
      // measured row height for every row not rendered.
      const rendered = current.end - current.start
      const span = bottom.getBoundingClientRect().top - top.getBoundingClientRect().bottom
      if (rendered > 0 && span > 0) rowPx.current = span / rendered
      const listTop = top.getBoundingClientRect().top
      const above = viewTop - listTop
      const start = Math.min(rows.length, Math.max(0, Math.floor(above / rowPx.current) - OVERSCAN))
      const end = Math.min(rows.length, Math.max(start, Math.ceil((above + viewHeight) / rowPx.current) + OVERSCAN))
      return start === current.start && end === current.end ? current : { start, end }
    })
  }, [rows.length])

  useEffect(() => {
    const top = topSpacer.current
    if (!top) return
    const container = scrollContainer(top)
    const target: HTMLElement | Window = container ?? window
    let frame = 0
    const schedule = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        update()
      })
    }
    const beforePrint = () => setPrinting(true)
    const afterPrint = () => setPrinting(false)
    schedule()
    target.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    window.addEventListener('beforeprint', beforePrint)
    window.addEventListener('afterprint', afterPrint)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      target.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('beforeprint', beforePrint)
      window.removeEventListener('afterprint', afterPrint)
    }
  }, [update])

  const start = printing ? 0 : range.start
  const end = printing ? rows.length : range.end
  return (
    <>
      <tr ref={topSpacer} aria-hidden="true" style={{ height: start * rowPx.current }}>
        <td colSpan={columns.length} className="p-0" />
      </tr>
      {rows.slice(start, end).map((row, offset) => (
        <TableRow key={String(resolveText(rowKey, row) || `row-${start + offset}`)}>
          {columns.map((column, index) => (
            <TableCell key={index} className={bodyCellClassName(column, row)}>
              <BrowserCell spec={column.cell} scope={row} />
            </TableCell>
          ))}
        </TableRow>
      ))}
      <tr ref={bottomSpacer} aria-hidden="true" style={{ height: (rows.length - end) * rowPx.current }}>
        <td colSpan={columns.length} className="p-0" />
      </tr>
    </>
  )
}
