import { EmptyState, cn } from '@openbooks/ui'
import type {
  CellSpec,
  TableBlock,
  Tone,
} from '@braedonsaunders/appkit-viewspec'
import {
  resolvePath,
  resolveRows,
  resolveText,
  resolveValue,
} from '@braedonsaunders/appkit-viewspec'
import {
  preparedListSource,
  preparedPageState,
  type PreparedListSourceKey,
} from '../../lib/list/prepared-sources'
import { RegisteredListTable } from '../registered-list-table'
import { CellView } from './cells'
import { nestedScope } from './list-scope'
import { SpanRowView, tablePrimitives } from './blocks'
import { toneClass } from './tone'

/** Search text comes only from displayed values. Internal reader fields must
 * not cross the client boundary merely to support client-side filtering. */
export function listCellSearchText(cell: CellSpec, scope: unknown): string {
  const leaf = cell.kind === 'drill' || cell.kind === 'txn' ? cell.inner : cell
  if ('field' in leaf) {
    const text = resolveText(leaf.field, scope)
    return leaf.kind === 'text'
      ? [
          text,
          leaf.prefix ? resolveText(leaf.prefix.field, scope) : '',
          leaf.suffix ? resolveText(leaf.suffix.field, scope) : '',
        ].join(' ')
      : text
  }
  return ''
}

/** Domain cells on the universal registered list renderer. The source owns
 * row identity and window semantics; a layout can rearrange cells but cannot
 * silently choose a different collection or reinterpret a server window. */
export function RegisteredListBlockView({
  source: key,
  spec,
  scope,
  searchParams,
}: {
  source: PreparedListSourceKey
  spec: TableBlock
  scope: unknown
  searchParams: Record<string, string | string[] | undefined>
}) {
  const source = preparedListSource(key)
  if (spec.kind !== 'table' || !Array.isArray(spec.columns))
    throw new Error('Invalid registered list definition: ' + key)
  if (!spec.rows || !('$' in spec.rows) || spec.rows.$ !== source.rowsField) {
    throw new Error(
      'The record-list collection does not match its registered source: ' + key,
    )
  }
  const tableScope = nestedScope(scope, scope)
  const rows = resolveRows(spec.rows, tableScope)
  const empty = spec.emptyRow ? (
    resolveText(spec.emptyRow.text, tableScope)
  ) : spec.empty ? (
    <EmptyState
      title={resolveText(spec.empty.title, tableScope)}
      description={resolveText(spec.empty.description, tableScope) || undefined}
    />
  ) : (
    ''
  )
  const primitives = tablePrimitives('app')
  return (
    <RegisteredListTable
      source={key}
      rows={rows}
      rowKey={(row) => {
        const identity = resolvePath(row, source.rowKeyField ?? '')
        return typeof identity === 'string' ? identity : ''
      }}
      empty={empty}
      basePath={
        source.basePathField
          ? String(resolvePath(tableScope, source.basePathField))
          : source.route
      }
      state={
        source.mode === 'server'
          ? preparedPageState(source, tableScope)
          : undefined
      }
      currentParams={searchParams}
      pageParamKey={source.paging?.pageParamKey ?? spec.sorting?.pageParamKey}
      sort={
        spec.sorting ? resolveText(spec.sorting.sort, tableScope) : undefined
      }
      dir={
        spec.sorting
          ? (resolveText(spec.sorting.dir, tableScope) as 'asc' | 'desc')
          : undefined
      }
      sortParamKey={spec.sorting?.sortParamKey}
      dirParamKey={spec.sorting?.dirParamKey}
      searchable={source.clientSearch !== false}
      paging={false}
      leading={spec.leading?.map((row, index) => (
        <SpanRowView
          key={index}
          row={row}
          scope={tableScope}
          primitives={primitives}
        />
      ))}
      footer={spec.trailing?.map((row, index) => (
        <SpanRowView
          key={index}
          row={row}
          scope={tableScope}
          primitives={primitives}
        />
      ))}
      columns={spec.columns.map((column, index) => ({
        key: String(index),
        header: column.srOnlyHeader ? (
          <span className="sr-only">
            {resolveText(column.header, tableScope)}
          </span>
        ) : (
          resolveText(column.header, tableScope)
        ),
        headerClassName: cn(
          column.align === 'right' && 'text-right',
          column.align === 'center' && 'text-center',
          column.headerClassName,
        ),
        sortKey: column.sort,
        align: column.align,
        className: cn(
          column.align === 'right' && 'text-right',
          column.align === 'center' && 'text-center',
          column.className,
        ),
        cell: (row) => {
          const rowScope = nestedScope(row, tableScope)
          const leaf =
            column.cell.kind === 'drill' || column.cell.kind === 'txn'
              ? column.cell.inner
              : column.cell
          const tone = toneClass(
            'tone' in leaf
              ? (resolveValue(leaf.tone as never, rowScope) as Tone | undefined)
              : undefined,
          )
          return (
            <span
              className={cn(
                (leaf.kind === 'money' || leaf.kind === 'number') &&
                  'tabular-nums',
                tone,
              )}
            >
              <CellView spec={column.cell} scope={rowScope} />
            </span>
          )
        },
        search: (row) =>
          listCellSearchText(column.cell, nestedScope(row, tableScope)),
      }))}
    />
  )
}
