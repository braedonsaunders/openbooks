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
  type ReportBreakout,
  type ReportCustomQuery,
  type ReportGroup,
  type ReportMeasure,
  type ReportRunResult,
  type ReportTemporalBin,
} from './types'

/** Structural pg-client contract (pg.Pool / pg.Client / pg.PoolClient). */
export type PgQueryable = {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

/**
 * Locale hooks for every display string this executor bakes into a shaped
 * result (column headings, group titles, subtitles, summary labels, boolean
 * cells). The web layer builds one from the request locale; every hook is
 * optional and falls back to the authored English, so tests and non-request
 * callers need nothing. Plain callbacks — this package stays i18n-runtime-free.
 */
export type ReportRunLabels = {
  /** Heading for an output column (fallback: catalog label). */
  column?: (entity: ReportEntity, key: string) => string
  /** Heading for a summarize-mode measure (fallback: "<Fn> of <column>"). */
  measure?: (entity: ReportEntity, m: ReportMeasure) => string
  /** Heading for a summarize-mode breakout (fallback: "<column> (by <bin>)"). */
  breakout?: (entity: ReportEntity, b: ReportBreakout) => string
  /** Title of the single unsectioned results group. */
  resultsTitle?: () => string
  /** Title of the summarize-mode group. */
  summaryTitle?: () => string
  /** Title of one groupBy section: "<column label>: <value>". */
  sectionTitle?: (columnLabel: string, value: string) => string
  /** "<n> row(s)" subtitle. */
  rowCount?: (n: number) => string
  /** "<n> group(s)" subtitle. */
  groupCount?: (n: number) => string
  /** Summary-band labels. */
  summaryRows?: () => string
  summaryGroups?: () => string
  summarySource?: () => string
  /** Summary-band grand-total label over a measure heading. */
  summaryTotal?: (measureHeading: string) => string
  /** Bucket title for rows whose groupBy value is null. */
  none?: () => string
  /** Boolean enum cell text (fallback: 'yes'/'no'). */
  bool?: (v: boolean) => string
  /** Enum cell text (e.g. 'vendor_bill' → 'Bill'). Return null/undefined to
   *  fall back to the humanized raw value. */
  enumValue?: (v: string) => string | null | undefined
  /** Display label for the entity itself (the summary band's Source value). */
  entityLabel?: (entity: ReportEntity) => string
}

export type RunCustomQueryOpts = CompileCustomQueryOpts & {
  /** Entity catalog to resolve against; injectable for tests/scoped catalogs. */
  entityMap: Record<string, ReportEntity>
  /** Org every query is scoped to — bound into the WHERE, never optional. */
  orgId: string
  /** Locale hooks for baked display strings (defaults: authored English). */
  labels?: ReportRunLabels
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

  const compiled = compileCustomQuery(entity, q, opts.orgId, {
    maxRows: opts.maxRows,
    fiscalStartMonth: opts.fiscalStartMonth,
  })
  const { rows } = await client.query(compiled.text, compiled.values)

  const labels = opts.labels ?? {}
  if (compiled.mode === 'summarize') {
    return shapeSummarizeResult(entity, compiled.breakouts, compiled.measures, rows, labels)
  }
  return shapeRowsResult(entity, compiled.columns, compiled.groupBy, rows, labels, q.columnLabels ?? undefined)
}

// --- rows mode ---------------------------------------------------------------

function shapeRowsResult(
  entity: ReportEntity,
  requestedColumns: string[],
  groupBy: string | null,
  dataRows: Record<string, unknown>[],
  labels: ReportRunLabels,
  overrides?: Record<string, string>,
): ReportRunResult {
  const groups: ReportGroup[] = []
  // A user-authored label override wins over the localized catalog heading.
  const columnLabel = (c: string) =>
    overrides?.[c]?.trim() || (labels.column?.(entity, c) ?? labelFor(entity, c))
  const columnLabels = requestedColumns.map(columnLabel)
  const resultsTitle = labels.resultsTitle?.() ?? 'Results'
  const rowCount = (n: number) => labels.rowCount?.(n) ?? `${n} row(s)`
  const cell = (column: string, v: unknown) => formatCellValue(entity, column, v, labels)
  const moneyFlags = requestedColumns.map(
    (c) => entity.columns.find((col) => col.key === c)?.kind === 'money',
  )
  const money = moneyFlags.some(Boolean) ? moneyFlags : undefined

  if (groupBy) {
    const byKey = new Map<string, Record<string, unknown>[]>()
    for (const row of dataRows) {
      const k = row[groupBy] == null ? (labels.none?.() ?? '(none)') : String(row[groupBy])
      const list = byKey.get(k) ?? []
      list.push(row)
      byKey.set(k, list)
    }
    if (byKey.size === 0) {
      groups.push({ kind: 'results', title: resultsTitle, columns: columnLabels, rows: [], isEmpty: true, money })
    } else {
      for (const [k, list] of [...byKey.entries()].sort()) {
        groups.push({
          kind: 'section',
          title:
            labels.sectionTitle?.(columnLabel(groupBy), formatLabel(k)) ??
            `${columnLabel(groupBy)}: ${formatLabel(k)}`,
          subtitle: rowCount(list.length),
          columns: columnLabels,
          rows: list.map((row) => requestedColumns.map((c) => cell(c, row[c]))),
          money,
          groupKey: { field: groupBy, value: k },
        })
      }
    }
  } else {
    groups.push({
      kind: 'results',
      title: resultsTitle,
      subtitle: rowCount(dataRows.length),
      columns: columnLabels,
      rows: dataRows.map((row) => requestedColumns.map((c) => cell(c, row[c]))),
      isEmpty: dataRows.length === 0,
      money,
    })
  }

  return {
    groups,
    summary: [
      { label: labels.summaryRows?.() ?? 'Rows', value: dataRows.length },
      { label: labels.summarySource?.() ?? 'Source', value: labels.entityLabel?.(entity) ?? entity.label },
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
  labels: ReportRunLabels,
): ReportRunResult {
  const measureHeading = (m: (typeof measures)[number]) =>
    labels.measure?.(entity, m) ?? measureLabel(entity, m)
  const columns = [
    ...breakouts.map((b) => labels.breakout?.(entity, b) ?? breakoutLabel(entity, b)),
    ...measures.map(measureHeading),
  ]
  const rows = dataRows.map((row) => [
    ...breakouts.map((b, i) =>
      b.bin
        ? formatBreakoutValue(row[`d${i}`], b.bin)
        : formatCellValue(entity, b.column, row[`d${i}`], labels),
    ),
    ...measures.map((_, i) => formatCustomValue(row[`m${i}`])),
  ])

  const measureIsMoney = (m: (typeof measures)[number]) =>
    m.fn !== 'count'
    && !!m.column
    && entity.columns.find((col) => col.key === m.column)?.kind === 'money'
  const moneyFlags = [...breakouts.map(() => false), ...measures.map(measureIsMoney)]
  const groups: ReportGroup[] = [
    {
      kind: 'summary',
      title: labels.summaryTitle?.() ?? 'Summary',
      subtitle:
        breakouts.length > 0
          ? (labels.groupCount?.(dataRows.length) ??
            `${dataRows.length} group${dataRows.length === 1 ? '' : 's'}`)
          : undefined,
      columns,
      rows,
      isEmpty: dataRows.length === 0,
      money: moneyFlags.some(Boolean) ? moneyFlags : undefined,
    },
  ]

  // Grand totals for count/sum measures make useful summary cards.
  const summary: ReportRunResult['summary'] = [
    {
      label:
        breakouts.length > 0
          ? (labels.summaryGroups?.() ?? 'Groups')
          : (labels.summaryRows?.() ?? 'Rows'),
      value: dataRows.length,
    },
  ]
  measures.forEach((m, i) => {
    if (m.fn === 'count' || m.fn === 'count_distinct' || m.fn === 'sum') {
      const total = sumExactDecimals(dataRows.map((row) => row[`m${i}`]))
      summary.push({
        label:
          labels.summaryTotal?.(measureHeading(m)) ??
          `Total ${measureLabel(entity, m).toLowerCase()}`,
        value: formatExactNumber(total) ?? '0.00',
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
function formatCellValue(
  entity: ReportEntity,
  column: string,
  v: unknown,
  labels: ReportRunLabels = {},
): string | number | null {
  const kind = entityColumn(entity, column)?.kind
  if (kind === 'enum') {
    if (typeof v === 'boolean') return labels.bool?.(v) ?? (v ? 'yes' : 'no')
    if (typeof v === 'string') return labels.enumValue?.(v) ?? formatLabel(v)
  }
  // Date columns come back as Date objects at LOCAL midnight (pg's date
  // parser) — print local date parts; toISOString would shift a day east of
  // UTC.
  if (kind === 'date' && v != null) {
    if (v instanceof Date) {
      const mm = String(v.getMonth() + 1).padStart(2, '0')
      const dd = String(v.getDate()).padStart(2, '0')
      return `${v.getFullYear()}-${mm}-${dd}`
    }
    return String(v).slice(0, 10)
  }
  // Numeric columns: normalize trailing zeros ("2938.0000" → "2938.00") while
  // preserving genuine precision (rates like 0.0625 pass through untouched).
  if ((kind === 'number' || kind === 'money') && v != null) {
    const formatted = formatExactNumber(v)
    if (formatted !== null) return formatted
  }
  return formatCustomValue(v)
}

function decimalParts(value: unknown): { units: bigint; scale: number } | null {
  const raw = String(value ?? '').trim()
  const match = /^([-+]?)(\d+)(?:\.(\d*))?$/.exec(raw)
  if (!match) return null
  const fraction = match[3] ?? ''
  const magnitude = BigInt(match[2]! + fraction)
  return { units: match[1] === '-' ? -magnitude : magnitude, scale: fraction.length }
}

function sumExactDecimals(values: unknown[]): string {
  const parts = values.map(decimalParts).filter((part): part is { units: bigint; scale: number } => part !== null)
  const scale = parts.reduce((maximum, part) => Math.max(maximum, part.scale), 0)
  const units = parts.reduce((total, part) => total + part.units * 10n ** BigInt(scale - part.scale), 0n)
  const negative = units < 0n
  const absolute = negative ? -units : units
  if (scale === 0) return `${negative ? '-' : ''}${absolute}`
  const digits = absolute.toString().padStart(scale + 1, '0')
  return `${negative ? '-' : ''}${digits.slice(0, -scale)}.${digits.slice(-scale)}`
}

function formatExactNumber(value: unknown): string | null {
  const part = decimalParts(value)
  if (!part) return null
  const raw = String(value).replace(/^\+/, '')
  // True integers (years, counts) stay integers — only values that carry a
  // decimal point normalize to ledger-style two places.
  if (!raw.includes('.')) return raw
  const [whole, fraction = ''] = raw.split('.')
  if (fraction.length <= 2 || /^\d{0,2}0*$/.test(fraction)) {
    return `${whole}.${fraction.slice(0, 2).padEnd(2, '0')}`
  }
  return raw
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
 * groupBy) get a leading section column so the flat file stays lossless.
 * `sectionHeader` localizes that column's heading (default 'Section').
 */
export function reportResultToCsv(
  result: ReportRunResult,
  opts: { sectionHeader?: string } = {},
): string {
  const multi = result.groups.length > 1
  const lines: string[] = []
  const header = result.groups[0]?.columns ?? []
  lines.push([...(multi ? [opts.sectionHeader ?? 'Section'] : []), ...header].map(csvEscape).join(','))
  for (const group of result.groups) {
    for (const row of group.rows) {
      lines.push([...(multi ? [group.title] : []), ...row].map(csvEscape).join(','))
    }
  }
  return lines.join('\r\n') + '\r\n'
}
