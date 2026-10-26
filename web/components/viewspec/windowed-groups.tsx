'use client'

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Block, TableBlock } from '@braedonsaunders/appkit-viewspec'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../app/(app)/reports/ReportTable'
import { BROWSER_BLOCK_WIDGETS } from './browser-widgets'
import { TableView, type TablePrimitives } from './table-view'
import { BrowserCell } from './virtual-report-rows'
import { resolveWidgetProps, type WidgetRenderer } from './widget-props'
import { WINDOWED_ROWS_FROM, type WindowedGroup } from './windowed-rows'

const REPORT_PRIMITIVES = { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } as TablePrimitives

/** Rows' worth of sections the server renders before anything is measured. */
const FIRST_WINDOW_ROWS = 60
/** Pixels of sections kept rendered above and below the viewport. */
const OVERSCAN_PX = 1600
const ESTIMATED_ROW_PX = 33
const ESTIMATED_SECTION_PX = 96

function scrollContainer(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return node
  }
  return null
}

function rowCount(group: WindowedGroup): number {
  return group.rows.reduce((total, rows) => total + rows.length, 0)
}

function initialEnd(groups: readonly WindowedGroup[]): number {
  let rows = 0
  for (let index = 0; index < groups.length; index++) {
    rows += rowCount(groups[index]!)
    if (rows >= FIRST_WINDOW_ROWS) return index + 1
  }
  return groups.length
}

function Section({ blocks, group }: { blocks: readonly Block[]; group: WindowedGroup }) {
  return (
    <>
      {blocks.map((block, index) => {
        if (block.kind === 'widget') {
          const render = (BROWSER_BLOCK_WIDGETS as Record<string, WidgetRenderer | undefined>)[block.widget]
          return <Fragment key={index}>{render?.(resolveWidgetProps(block.props ?? {}, group.scope), group.scope)}</Fragment>
        }
        const rows = group.rows[index] ?? []
        return (
          <TableView
            key={index}
            spec={block as TableBlock}
            scope={group.scope}
            rows={rows}
            primitives={REPORT_PRIMITIVES}
            Cell={BrowserCell}
            windowed={rows.length > WINDOWED_ROWS_FROM}
          />
        )
      })}
    </>
  )
}

/**
 * The repeated sections of a long grouped report (one per account or party),
 * rendered a window at a time around the viewport. Spacers hold the height of
 * the sections not rendered; a section's own long table windows its rows as
 * well. Printing renders every section.
 */
export function WindowedGroups({
  blocks,
  groups,
  className,
  itemClassName,
}: {
  blocks: Block[]
  groups: WindowedGroup[]
  className?: string
  itemClassName?: string
}) {
  const root = useRef<HTMLDivElement>(null)
  const heights = useRef(new Map<string, number>())
  const sectionPx = useRef(ESTIMATED_SECTION_PX)
  const [range, setRange] = useState({ start: 0, end: initialEnd(groups) })
  const [printing, setPrinting] = useState(false)

  const estimate = useCallback(
    (group: WindowedGroup) => heights.current.get(group.key) ?? sectionPx.current + rowCount(group) * ESTIMATED_ROW_PX,
    [],
  )

  // Record what each rendered section actually takes, margin included, and
  // learn the fixed part of a section from the ones measured.
  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    const fixed: number[] = []
    for (const node of element.querySelectorAll<HTMLElement>(':scope > [data-section-key]')) {
      const key = node.dataset.sectionKey!
      const height = node.getBoundingClientRect().height + parseFloat(getComputedStyle(node).marginTop || '0')
      heights.current.set(key, height)
      const group = groups.find((candidate) => candidate.key === key)
      if (group) fixed.push(Math.max(0, height - rowCount(group) * ESTIMATED_ROW_PX))
    }
    if (fixed.length > 0) sectionPx.current = fixed.reduce((a, b) => a + b, 0) / fixed.length
  })

  const update = useCallback(() => {
    const element = root.current
    if (!element) return
    const container = scrollContainer(element)
    const viewTop = container ? container.getBoundingClientRect().top : 0
    const viewHeight = container ? container.clientHeight : window.innerHeight
    const above = viewTop - element.getBoundingClientRect().top
    const from = above - OVERSCAN_PX
    const to = above + viewHeight + OVERSCAN_PX
    let offset = 0
    let start = groups.length
    let end = groups.length
    for (let index = 0; index < groups.length; index++) {
      const height = estimate(groups[index]!)
      if (start === groups.length && offset + height > from) start = index
      if (offset > to) {
        end = index
        break
      }
      offset += height
    }
    if (start === groups.length) start = Math.max(0, groups.length - 1)
    setRange((current) => (current.start === start && current.end === end ? current : { start, end: Math.max(start + 1, end) }))
  }, [estimate, groups])

  useEffect(() => {
    const element = root.current
    if (!element) return
    const target: HTMLElement | Window = scrollContainer(element) ?? window
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
  const end = printing ? groups.length : range.end
  const spacer = (from: number, to: number) => {
    let height = 0
    for (let index = from; index < to; index++) height += estimate(groups[index]!)
    return height
  }
  return (
    <div ref={root} className={className}>
      <div aria-hidden="true" style={{ height: spacer(0, start) }} />
      {groups.slice(start, end).map((group) => (
        <div key={group.key} data-section-key={group.key} className={itemClassName}>
          <Section blocks={blocks} group={group} />
        </div>
      ))}
      <div aria-hidden="true" style={{ height: spacer(end, groups.length) }} />
    </div>
  )
}
