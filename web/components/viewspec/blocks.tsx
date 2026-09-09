import type { ComponentProps } from 'react'
import { PageHeader, cn } from '@openbooks/ui'
import type { Block, PaperBlock, TableBlock, Tone } from '@openbooks/viewspec'
import { ROOT_SCOPE_KEY, resolveNumber, resolveRows, resolveText, resolveValue } from '@openbooks/viewspec'
import { Pagination } from '../pagination'
import { HomePanel, HomeStatTile } from '../module-home/client'
import {
  Table as ReportTableRoot,
  TableBody as ReportTableBody,
  TableCell as ReportTableCell,
  TableHead as ReportTableHead,
  TableHeader as ReportTableHeader,
  TableRow as ReportTableRow,
} from '../../app/(app)/reports/ReportTable'
import {
  Table as AppTableRoot,
  TableBody as AppTableBody,
  TableCell as AppTableCell,
  TableHead as AppTableHead,
  TableHeader as AppTableHeader,
  TableRow as AppTableRow,
  EmptyState,
} from '@openbooks/ui'
import { ReportPaper } from '../../app/(app)/reports/ReportPaper'
import { ReportFilterBar } from '../../app/(app)/reports/ReportFilterBar'
import { CellView } from './cells'
import { WidgetSlot, WidgetBlockView } from './widgets'
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
/**
 * The page scope, for `$root` resolution.
 *
 * `$root` always means the PAGE, at any nesting depth. Each nesting level
 * therefore PRESERVES an existing `$root` instead of pointing it at itself —
 * otherwise a table inside a repeat would shadow it and `$root.someLabel`
 * would silently resolve to nothing, rendering an empty cell that looks fine
 * until the DOM is diffed. That happened twice before this existed.
 */
function rootOf(scope: unknown): unknown {
  if (scope !== null && typeof scope === 'object' && ROOT_SCOPE_KEY in (scope as object)) {
    return (scope as Record<string, unknown>)[ROOT_SCOPE_KEY]
  }
  return scope
}

/** Scope for a nested item: its own fields, plus the page at `$root`. */
function nestedScope(item: unknown, scope: unknown): unknown {
  if (item === null || typeof item !== 'object') return item
  return { ...(item as object), [ROOT_SCOPE_KEY]: rootOf(scope) }
}

function leafOf(cell: TableBlock['columns'][number]['cell']) {
  // Every wrapper kind must be unwrapped here. Adding one and forgetting this
  // helper is how a converted cell silently loses its alignment or tone.
  return cell.kind === 'drill' || cell.kind === 'txn' ? cell.inner : cell
}

/** A spanning summary row (opening / closing / totals). Resolves against the
 *  table's own scope, not a row scope. */
function SpanRowView({
  row,
  scope,
  primitives,
}: {
  row: NonNullable<TableBlock['leading']>[number]
  scope: unknown
  primitives: ReturnType<typeof tablePrimitives>
}) {
  const { TableRow, TableCell } = primitives
  return (
    <TableRow className={row.className}>
      <TableCell colSpan={row.labelColSpan} className={row.labelClassName}>
        {resolveText(row.label, scope)}
      </TableCell>
      {row.cells.map((entry, index) => {
        // Tone is applied by the container here exactly as it is for body
        // cells; a span row that skipped it would silently drop the negative
        // treatment on a closing balance.
        const leaf = leafOf(entry.cell)
        const tone = toneClass(
          'tone' in leaf ? (resolveValue(leaf.tone as never, scope) as Tone | undefined) : undefined,
        )
        return (
          <TableCell key={index} className={cn(alignClass(entry.align), entry.className, tone) || undefined}>
            <CellView spec={entry.cell} scope={scope} />
          </TableCell>
        )
      })}
    </TableRow>
  )
}

function isNumericCell(cell: TableBlock['columns'][number]['cell']): boolean {
  const leaf = leafOf(cell)
  return leaf.kind === 'money' || leaf.kind === 'number'
}

/**
 * The app has two genuinely different tables and they are not interchangeable:
 * report primitives carry statement typography with no card, hover or row
 * dividers; app primitives are the list-page table with card chrome, a sticky
 * header and row entrance staggering. Picking the wrong one is a visible
 * difference, so the variant selects the whole primitive set rather than
 * toggling classes on one.
 */
function tablePrimitives(variant: TableBlock['variant']) {
  return variant === 'app'
    ? {
        Table: AppTableRoot,
        TableHeader: AppTableHeader,
        TableBody: AppTableBody,
        TableRow: AppTableRow,
        TableHead: AppTableHead,
        TableCell: AppTableCell,
      }
    : {
        Table: ReportTableRoot,
        TableHeader: ReportTableHeader,
        TableBody: ReportTableBody,
        TableRow: ReportTableRow,
        TableHead: ReportTableHead,
        TableCell: ReportTableCell,
      }
}

function TableBlockView({ spec, scope: rawScope }: { spec: TableBlock; scope: unknown }) {
  // Seed `$root` when absent so a page-level table resolves `$root.x` the same
  // way a nested one does. Without this, moving a table into or out of a
  // `repeat` would silently change what its headers resolve to.
  const scope = nestedScope(rawScope, rawScope)
  const primitives = tablePrimitives(spec.variant)
  const { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } = primitives
  const rows = resolveRows(spec.rows, scope)
  if (rows.length === 0 && spec.empty && !spec.emptyRow && !spec.leading && !spec.trailing) {
    // App list pages use the shared EmptyState; report papers use the plain
    // centred paragraph they already render.
    return spec.variant === 'app' ? (
      <EmptyState
        title={resolveText(spec.empty.title, scope)}
        description={resolveText(spec.empty.description, scope) || undefined}
      />
    ) : (
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
            <TableHead key={index} className={cn(alignClass(column.align), column.headerClassName) || undefined}>
              {resolveText(column.header, scope)}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {spec.leading?.map((row, index) => (
          <SpanRowView key={`lead-${index}`} row={row} scope={scope} primitives={primitives} />
        ))}
        {rows.length === 0 && spec.emptyRow ? (
          <TableRow>
            <TableCell colSpan={spec.emptyRow.colSpan} className={spec.emptyRow.className}>
              {resolveText(spec.emptyRow.text, scope)}
            </TableCell>
          </TableRow>
        ) : null}
        {rows.map((row, rowIndex) => {
          // Cells resolve against the row, with the page scope reachable at
          // `$root` for shared constants (placeholder text, labels). One fixed
          // name, not a parent-traversal operator.
          const rowScope = nestedScope(row, scope)
          return (
          <TableRow key={String(resolveText(spec.rowKey, rowScope) || `row-${rowIndex}`)}>
            {spec.columns.map((column, index) => {
              const leaf = leafOf(column.cell)
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
        {spec.trailing?.map((row, index) => (
          <SpanRowView key={`trail-${index}`} row={row} scope={scope} primitives={primitives} />
        ))}
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
          actions={
            block.actions ? (
              block.actionsClassName ? (
                <div className={block.actionsClassName}>
                  <WidgetSlot widgets={block.actions} scope={scope} />
                </div>
              ) : (
                <WidgetSlot widgets={block.actions} scope={scope} />
              )
            ) : undefined
          }
        />
      )

    case 'filter-bar': {
      // Each loader-resolved input goes to exactly one known prop. Deliberately
      // not a spread: a spread would let a spec set arbitrary props on this
      // component.
      const bind = <T,>(f: typeof block.dimensions): T | undefined =>
        f ? (resolveValue(f as never, scope) as T | undefined) : undefined
      return (
        <ReportFilterBar
          controls={block.controls}
          dimensions={bind<ComponentProps<typeof ReportFilterBar>['dimensions']>(block.dimensions)}
          subsidiaries={bind<ComponentProps<typeof ReportFilterBar>['subsidiaries']>(block.subsidiaries)}
          customers={bind<ComponentProps<typeof ReportFilterBar>['customers']>(block.customers)}
          dateRange={bind<ComponentProps<typeof ReportFilterBar>['dateRange']>(block.dateRange)}
          primaryFilter={bind<ComponentProps<typeof ReportFilterBar>['primaryFilter']>(block.primaryFilter)}
          periodPresets={bind<ComponentProps<typeof ReportFilterBar>['periodPresets']>(block.periodPresets)}
          defaultPeriod={resolveText(block.defaultPeriod, scope) || undefined}
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
                {block.leading.divider ? (
                  <span className="mx-1 h-4 w-px bg-slate-200 dark:bg-slate-700" />
                ) : null}
              </>
            ) : undefined
          }
          actions={block.actions ? <WidgetSlot widgets={block.actions} scope={scope} /> : undefined}
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
      if (block.when && !resolveValue(block.when as never, scope)) return null
      const tone = toneClass(resolveValue(block.tone as never, scope) as Tone | undefined)
      return (
        <p className={cn('text-xs', tone, block.className) || undefined}>{resolveText(block.content, scope)}</p>
      )
    }

    case 'widget': {
      if (block.when && !resolveValue(block.when as never, scope)) return null
      return <WidgetBlockView name={block.widget} props={block.props ?? {}} scope={scope} />
    }

    case 'repeat': {
      const items = resolveRows(block.items, scope)
      if (items.length === 0) {
        return block.empty ? (
          <p className={block.empty.className}>{resolveText(block.empty.text, scope)}</p>
        ) : null
      }
      const list = items.map((item, index) => {
        // Same scoping contract as a table row: the item is the scope, the page
        // stays reachable at `$root`.
        const itemScope = nestedScope(item, scope)
        const key = String(resolveText(block.itemKey, itemScope) || `item-${index}`)
        const body = <BlockList blocks={block.blocks} scope={itemScope} searchParams={searchParams} />
        return block.itemClassName !== undefined ? (
          <div key={key} className={block.itemClassName}>
            {body}
          </div>
        ) : (
          <div key={key}>{body}</div>
        )
      })
      return block.className ? <div className={block.className}>{list}</div> : <>{list}</>
    }

    case 'grid':
      return (
        <div className={block.className}>
          <BlockList blocks={block.blocks} scope={scope} searchParams={searchParams} />
        </div>
      )

    case 'panel':
      return (
        <HomePanel
          title={resolveText(block.title, scope)}
          icon={resolveText(block.iconKey, scope) || undefined}
          hint={resolveText(block.hint, scope) || undefined}
          className={block.className}
          bodyClassName={block.bodyClassName}
        >
          <BlockList blocks={block.blocks} scope={scope} searchParams={searchParams} />
        </HomePanel>
      )

    case 'stat-tile': {
      if (block.when && !resolveValue(block.when as never, scope)) return null
      return (
        <HomeStatTile
          icon={resolveText(block.iconKey, scope)}
          accent={resolveText(block.accent, scope) as ComponentProps<typeof HomeStatTile>['accent']}
          label={resolveText(block.label, scope)}
          value={resolveText(block.value, scope)}
          sub={resolveText(block.sub, scope) || undefined}
          tone={resolveValue(block.tone as never, scope) as ComponentProps<typeof HomeStatTile>['tone']}
        />
      )
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
