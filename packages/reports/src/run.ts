// Executor for custom reports: compile a ReportCustomQuery (custom-query.ts)
// and run it against a caller-provided pg client, shaping the raw rows into
// the shared ReportRunResult (groups + summary) that the results view, the
// CSV export, and any future scheduled-document pipeline all consume.
//
// The client is anything with pg's query(text, values) shape — a Pool, a
// Client, or a checked-out PoolClient inside a transaction. This package
// never owns a connection.

import { entityColumn, type ReportEntity } from './entities'
import {
  breakoutLabel,
  compileCustomQuery,
  labelFor,
  measureLabel,
  type CompileCustomQueryOpts,
} from './custom-query'
import {
  formatLabel,
  type ReportCustomQuery,
  type ReportGroup,
  type ReportRunResult,
  type ReportTemporalBin,
} from './types'

/** Structural pg-client contract (pg.Pool / pg.Client / pg.PoolClient). */
export type PgQueryable = {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

export type RunCustomQueryOpts = CompileCustomQueryOpts & {
  /** Entity catalog to resolve against; injectable for tests/scoped catalogs. */
  entityMap: Record<string, ReportEntity>
  /** Org every query is scoped to — bound into the WHERE, never optional. */
  orgId: string
}

export async function runCustomQuery(
  client: PgQueryable,
  customQuery: unknown,
  opts: RunCustomQueryOpts,
): Promise<ReportRunResult> {
  const q = (customQuery ?? null) as ReportCustomQuery | null
  const entity = q?.entity ? opts.entityMap[q.entity] : null
  if (!q || !entity) {
    throw new Error('Custom query missing or has unknown entity')
  }

  const compiled = compileCustomQuery(entity, q, opts.orgId, { maxRows: opts.maxRows })
  const { rows } = await client.query(compiled.text, compiled.values)

  if (compiled.mode === 'summarize') {
    return shapeSummarizeResult(entity, compiled.breakouts, compiled.measures, rows)
  }
  return shapeRowsResult(entity, compiled.columns, compiled.groupBy, rows)
}

// --- rows mode ---------------------------------------------------------------

function shapeRowsResult(
  entity: ReportEntity,
  requestedColumns: string[],
  groupBy: string | null,
  dataRows: Record<string, unknown>[],
): ReportRunResult {
  const groups: ReportGroup[] = []
  const columnLabels = requestedColumns.map((c) => labelFor(entity, c))
  const cell = (column: string, v: unknown) => formatCellValue(entity, column, v)

  if (groupBy) {
    const byKey = new Map<string, Record<string, unknown>[]>()
    for (const row of dataRows) {
      const k = String(row[groupBy] ?? '(none)')
      const list = byKey.get(k) ?? []
      list.push(row)
      byKey.set(k, list)
    }
    if (byKey.size === 0) {
      groups.push({ title: 'Results', columns: columnLabels, rows: [], isEmpty: true })
    } else {
      for (const [k, list] of [...byKey.entries()].sort()) {
        groups.push({
          title: `${labelFor(entity, groupBy)}: ${formatLabel(k)}`,
          subtitle: `${list.length} row(s)`,
          columns: columnLabels,
          rows: list.map((row) => requestedColumns.map((c) => cell(c, row[c]))),
        })
      }
    }
  } else {
    groups.push({
      title: 'Results',
      subtitle: `${dataRows.length} row(s)`,
      columns: columnLabels,
      rows: dataRows.map((row) => requestedColumns.map((c) => cell(c, row[c]))),
      isEmpty: dataRows.length === 0,
    })
  }

  return {
    groups,
    summary: [
      { label: 'Rows', value: dataRows.length },
      { label: 'Source', value: entity.label },
    ],
    rowCount: dataRows.length,
  }
}

// --- summarize mode ----------------------------------------------------------

function shapeSummarizeResult(
  entity: ReportEntity,
  breakouts: NonNullable<ReportCustomQuery['breakouts']>,
  measures: NonNullable<ReportCustomQuery['measures']>,
  dataRows: Record<string, unknown>[],
): ReportRunResult {
  const columns = [
    ...breakouts.map((b) => breakoutLabel(entity, b)),
    ...measures.map((m) => measureLabel(entity, m)),
  ]
  const rows = dataRows.map((row) => [
    ...breakouts.map((b, i) =>
      b.bin
        ? formatBreakoutValue(row[`d${i}`], b.bin)
        : formatCellValue(entity, b.column, row[`d${i}`]),
    ),
    ...measures.map((_, i) => formatCustomValue(row[`m${i}`])),
  ])

  const groups: ReportGroup[] = [
    {
      title: 'Summary',
      subtitle:
        breakouts.length > 0
          ? `${dataRows.length} group${dataRows.length === 1 ? '' : 's'}`
          : undefined,
      columns,
      rows,
      isEmpty: dataRows.length === 0,
    },
  ]

  // Grand totals for count/sum measures make useful summary cards.
  const summary: ReportRunResult['summary'] = [
    { label: breakouts.length > 0 ? 'Groups' : 'Rows', value: dataRows.length },
  ]
  measures.forEach((m, i) => {
    if (m.fn === 'count' || m.fn === 'count_distinct' || m.fn === 'sum') {
      const total = dataRows.reduce((acc, r) => acc + (Number(r[`m${i}`]) || 0), 0)
      summary.push({
        label: `Total ${measureLabel(entity, m).toLowerCase()}`,
        value: Math.round(total * 100) / 100,
      })
    }
  })

  return { groups, summary, rowCount: dataRows.length }
}

// --- value formatting ----------------------------------------------------------

/** Format a temporal-bucketed dimension value for display. */
function formatBreakoutValue(v: unknown, bin?: ReportTemporalBin): string | number | null {
  if (!bin) return formatCustomValue(v)
  if (v === null || typeof v === 'undefined') return null
  const iso = v instanceof Date ? v.toISOString() : String(v)
  switch (bin) {
    case 'year':
      return iso.slice(0, 4)
    case 'quarter': {
      const d = v instanceof Date ? v : new Date(iso)
      if (Number.isNaN(d.getTime())) return iso.slice(0, 7)
      return `${d.getUTCFullYear()} Q${Math.floor(d.getUTCMonth() / 3) + 1}`
    }
    case 'month':
      return iso.slice(0, 7)
    default:
      return iso.slice(0, 10) // day, week
  }
}

/** Cell value for display: enum-kind columns print humanised (underscores →
 *  spaces), everything else through formatCustomValue. */
function formatCellValue(entity: ReportEntity, column: string, v: unknown): string | number | null {
  const kind = entityColumn(entity, column)?.kind
  if (kind === 'enum') {
    if (typeof v === 'boolean') return v ? 'yes' : 'no'
    if (typeof v === 'string') return formatLabel(v)
  }
  return formatCustomValue(v)
}

function formatCustomValue(v: unknown): string | number | null {
  if (v === null || typeof v === 'undefined') return null
  if (v instanceof Date) return v.toISOString().slice(0, 19).replace('T', ' ')
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'object') return JSON.stringify(v)
  if (typeof v === 'number' || typeof v === 'string') return v
  return String(v)
}

// --- CSV export ----------------------------------------------------------------

function csvEscape(v: string | number | null | undefined): string {
  if (v === null || typeof v === 'undefined') return ''
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * Serialize a run result to CSV. Multi-section results (rows mode with a
 * groupBy) get a leading "Section" column so the flat file stays lossless.
 */
export function reportResultToCsv(result: ReportRunResult): string {
  const multi = result.groups.length > 1
  const lines: string[] = []
  const header = result.groups[0]?.columns ?? []
  lines.push([...(multi ? ['Section'] : []), ...header].map(csvEscape).join(','))
  for (const group of result.groups) {
    for (const row of group.rows) {
      lines.push([...(multi ? [group.title] : []), ...row].map(csvEscape).join(','))
    }
  }
  return lines.join('\r\n') + '\r\n'
}
