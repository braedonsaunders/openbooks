import { PageHeader, cn } from '@openbooks/ui'
import type { Block, PaperBlock, TableBlock, Tone } from '@openbooks/viewspec'
import { ROOT_SCOPE_KEY, resolveNumber, resolveRows, resolveText, resolveValue } from '@openbooks/viewspec'
import { Pagination } from '../pagination'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../app/(app)/reports/ReportTable'
import { ReportPaper } from '../../app/(app)/reports/ReportPaper'
import { ReportFilterBar } from '../../app/(app)/reports/ReportFilterBar'
import { CellView } from './cells'
import { WidgetSlot } from './widgets'
import { toneClass } from './tone'
import Link from 'next/link'
import { Badge } from '@openbooks/ui'

/**
 * Block renderers — the closed registry.
 *
 * Every renderer delegates to the component the native pages already use. It
 * deliberately adds no markup of its own: the conformance harness compares a
 * converted page's output against its native output byte for byte, so a
 * wrapper div introduced here would be a failure, not a detail. Where a native
 * page wrapped something in a `<div className="mt-3">`, that spacing is
 * expressed by the block that owns it (see `pagination`) rather than by an
 * ambient container.
 *
 * Adding a block kind means adding a case here AND to the schema union. The
 * two are intentionally coupled: a kind the schema accepts but this switch
 * cannot render would be a runtime hole, so the exhaustive switch is the
 * enforcement.
 */

/** Column alignment → the exact classes the native tables use. */
function alignClass(align: 'left' | 'right' | 'center' | undefined): string {
  if (align === 'right') return 'text-right'
  if (align === 'center') return 'text-center'
  return ''
}

/**
 * Money and number columns carry `tabular-nums` on the cell, matching the
 * native pages. Doing it here rather than in the cell renderer keeps the
 * figure alignment attached to the column, which is where it belongs.
 */
function isNumericCell(cell: TableBlock['columns'][number]['cell']): boolean {
  const leaf = cell.kind === 'drill' ? cell.inner : cell
  return leaf.kind === 'money' || leaf.kind === 'number'
}

function TableBlockView({ spec, scope }: { spec: TableBlock; scope: unknown }) {
  const rows = resolveRows(spec.rows, scope)
  if (rows.length === 0 && spec.empty) {
    return (
      <div className="px-4 py-10 text-center">
        <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
          {resolveText(spec.empty.title, scope)}
        </p>
        {spec.empty.description ? (
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {resolveText(spec.empty.description, scope)}
          </p>
        ) : null}
      </div>
    )
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {spec.columns.map((column, index) => (
            <TableHead key={index} className={alignClass(column.align) || undefined}>
              {resolveText(column.header, scope)}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, rowIndex) => {
          // Cells resolve against the row, with the page scope reachable at
          // `$root` for shared constants (placeholder text, labels). One fixed
          // name, not a parent-traversal operator.
          const rowScope =
            row !== null && typeof row === 'object' ? { ...(row as object), [ROOT_SCOPE_KEY]: scope } : row
          return (
          <TableRow key={String(resolveText(spec.rowKey, rowScope) || `row-${rowIndex}`)}>
            {spec.columns.map((column, index) => {
              const leaf = column.cell.kind === 'drill' ? column.cell.inner : column.cell
              // Only the value-bearing renderers carry a tone; date/badge/link
              // cells own their own presentation.
              const tone = toneClass(
                'tone' in leaf ? (resolveValue(leaf.tone as never, rowScope) as Tone | undefined) : undefined,
              )
              const className =
                cn(alignClass(column.align), isNumericCell(column.cell) && 'tabular-nums', tone, column.className) ||
                undefined
              return (
                <TableCell key={index} className={className}>
                  <CellView spec={column.cell} scope={rowScope} />
                </TableCell>
              )
            })}
          </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

function PaperBlockView({
  spec,
  scope,
  searchParams,
}: {
  spec: PaperBlock
  scope: unknown
  searchParams: Record<string, string | string[] | undefined>
}) {
  return (
    <ReportPaper
      company={resolveText(spec.company, scope)}
      title={resolveText(spec.title, scope)}
      periodPhrase={resolveText(spec.periodPhrase, scope) || undefined}
      note={resolveText(spec.note, scope) || undefined}
      wide={resolveValue(spec.wide as never, scope) as boolean | undefined}
    >
      <BlockList blocks={spec.blocks} scope={scope} searchParams={searchParams} />
    </ReportPaper>
  )
}

export function BlockView({
  block,
  scope,
  searchParams,
}: {
  block: Block
  scope: unknown
  searchParams: Record<string, string | string[] | undefined>
}) {
  switch (block.kind) {
    case 'page-header':
      return (
        <PageHeader
          title={resolveText(block.title, scope)}
          description={resolveText(block.description, scope) || undefined}
          back={
            block.back
              ? { href: resolveText(block.back.href, scope), label: resolveText(block.back.label, scope) }
              : undefined
          }
          actions={block.actions ? <WidgetSlot widgets={block.actions} scope={scope} /> : undefined}
        />
      )

    case 'filter-bar': {
      const options = block.options
        ? (resolveValue(block.options as never, scope) as Record<string, unknown> | undefined)
        : undefined
      return (
        <ReportFilterBar
          controls={block.controls}
          searchPlaceholder={resolveText(block.searchPlaceholder, scope) || undefined}
          leading={
            block.leading ? (
              <>
                {block.leading.links.map((entry, index) => {
                  const active = Boolean(resolveValue(entry.activeWhen as never, scope))
                  return (
                    <Link key={index} href={resolveText(entry.href, scope)}>
                      <Badge variant={active ? 'default' : 'outline'}>{resolveText(entry.label, scope)}</Badge>
                    </Link>
                  )
                })}
              </>
            ) : undefined
          }
          actions={block.actions ? <WidgetSlot widgets={block.actions} scope={scope} /> : undefined}
          {...(options ?? {})}
        />
      )
    }

    case 'summary-line':
      return (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {resolveText(block.label, scope)}:{' '}
          <span className="font-semibold tabular-nums text-slate-700 dark:text-slate-200">
            <CellView spec={block.value} scope={scope} />
          </span>
        </p>
      )

    case 'paper':
      return <PaperBlockView spec={block} scope={scope} searchParams={searchParams} />

    case 'table':
      return <TableBlockView spec={block} scope={scope} />

    case 'pagination':
      return (
        <div className="mt-3">
          <Pagination
            basePath={resolveText(block.basePath, scope)}
            currentParams={searchParams}
            total={resolveNumber(block.total, scope)}
            page={resolveNumber(block.page, scope)}
            perPage={resolveNumber(block.perPage, scope)}
          />
        </div>
      )

    case 'text': {
      const tone = toneClass(resolveValue(block.tone as never, scope) as Tone | undefined)
      return <p className={cn('text-xs', tone) || undefined}>{resolveText(block.content, scope)}</p>
    }
  }
}

export function BlockList({
  blocks,
  scope,
  searchParams,
}: {
  blocks: Block[]
  scope: unknown
  searchParams: Record<string, string | string[] | undefined>
}) {
  return (
    <>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} scope={scope} searchParams={searchParams} />
      ))}
    </>
  )
}
