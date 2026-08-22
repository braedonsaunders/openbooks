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
  isoDate,
  type ReportBreakout,
  type ReportCustomQuery,
  type ReportGroup,
  type ReportMeasure,
  type ReportRunResult,
  type ReportRowScopeRule,
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
  /** Subtotal-row label over a level value ("Earnings — total"). */
  subtotal?: (level: string) => string
  /** Title of the sectioned-summarize Grand totals group. */
  grandTotalsTitle?: () => string
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
    asOf: opts.asOf,
  })
  const { rows } = await client.query(compiled.text, compiled.values)

  const labels = opts.labels ?? {}
  if (compiled.mode === 'summarize') {
    return shapeSummarizeResult(
      entity, compiled.breakouts, compiled.measures, rows, labels,
      compiled.groupBy, compiled.totals ?? null,
    )
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
  const align = requestedColumns.map((c) => {
    const kind = entity.columns.find((col) => col.key === c)?.kind
    return kind === 'money' || kind === 'number' ? ('right' as const) : ('left' as const)
  })

  if (groupBy) {
    const byKey = new Map<string, Record<string, unknown>[]>()
    for (const row of dataRows) {
      const k = row[groupBy] == null ? (labels.none?.() ?? '(none)') : String(row[groupBy])
      const list = byKey.get(k) ?? []
      list.push(row)
      byKey.set(k, list)
    }
    if (byKey.size === 0) {
      groups.push({ kind: 'results', title: resultsTitle, columns: columnLabels, rows: [], isEmpty: true, money, align })
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
          align,
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
      align,
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
  groupBy: string | null = null,
  totals: ReportCustomQuery['totals'] = null,
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

  // Exact per-row scope of each aggregate bucket: eq for plain breakouts,
  // a date range for binned buckets, is-empty for null buckets. A row whose
  // bucket cannot be scoped precisely gets null — viewers then offer NO drill
  // rather than showing records that don't add up to the clicked number.
  const rowKeys = dataRows.map((row): ReportRowScopeRule[] | null => {
    const scope: ReportRowScopeRule[] = []
    for (const [i, b] of breakouts.entries()) {
      const raw = row[`d${i}`]
      if (raw === null || typeof raw === 'undefined') {
        scope.push({ field: b.column, empty: true })
        continue
      }
      if (b.bin) {
        const range = binRange(raw, b.bin)
        if (!range) return null
        scope.push({ field: b.column, ...range })
      } else {
        scope.push({ field: b.column, value: String(raw) })
      }
    }
    return scope
  })

  const measureIsMoney = (m: (typeof measures)[number]) =>
    m.fn !== 'count'
    && !!m.column
    && entity.columns.find((col) => col.key === m.column)?.kind === 'money'
  const moneyFlags = [...breakouts.map(() => false), ...measures.map(measureIsMoney)]
  const alignFlags = [
    ...breakouts.map(() => 'left' as const),
    ...measures.map(() => 'right' as const),
  ]

  // A derived footer row (e.g. Net pay = earnings − deductions) over a set of
  // raw aggregate rows: per summable measure, plus-bucket sum minus
  // minus-bucket sum, exact decimals. Returns null when the spec's field is
  // not a breakout of this query (fail closed: no row beats a wrong row).
  const buildDerivedRow = (
    spec: NonNullable<NonNullable<ReportCustomQuery['totals']>['derived']>[number],
    raws: Record<string, unknown>[],
    width: number,
    labelPos: number,
    summableFlags: boolean[],
    measureOffset: number,
  ): (string | number | null)[] | null => {
    const fieldIndex = breakouts.findIndex((b) => b.column === spec.plus.field && !b.bin)
    const minusIndex = spec.minus ? breakouts.findIndex((b) => b.column === spec.minus!.field && !b.bin) : fieldIndex
    if (fieldIndex < 0 || minusIndex < 0) return null
    const row = Array.from({ length: width }, () => null as string | number | null)
    row[labelPos] = spec.label
    measures.forEach((m, mi) => {
      if (!summableFlags[mi]) return
      const plusInputs = raws.filter((r) => String(r[`d${fieldIndex}`] ?? '') === spec.plus.value).map((r) => r[`m${mi}`])
      const minusInputs = spec.minus
        ? raws.filter((r) => String(r[`d${minusIndex}`] ?? '') === spec.minus!.value).map((r) => r[`m${mi}`])
        : []
      if (plusInputs.every((v) => v == null) && minusInputs.every((v) => v == null)) return
      const total = subtractExactDecimals(sumExactDecimals(plusInputs), sumExactDecimals(minusInputs))
      row[measureOffset + mi] = m.fn === 'sum' || m.fn === 'latest'
        ? (formatExactNumber(total) ?? total)
        : Number(total)
    })
    return row
  }

  // Sectioned summarize: one titled group per bucket of the groupBy breakout
  // (the payroll journal's per-employee blocks), that column lifted out of the
  // table. Row scope keys stay COMPLETE so drills still hit the exact bucket.
  const sectionIndex = groupBy ? breakouts.findIndex((b) => b.column === groupBy && !b.bin) : -1
  let groups: ReportGroup[]
  if (sectionIndex >= 0 && dataRows.length > 0) {
    const drop = (list: unknown[]) => list.filter((_, i) => i !== sectionIndex)
    const sectionLabel = labels.breakout?.(entity, breakouts[sectionIndex]!)
      ?? breakoutLabel(entity, breakouts[sectionIndex]!)
    const sectionColumns = drop(columns) as string[]
    const sectionMoney = drop(moneyFlags) as boolean[]
    const sectionAlign = drop(alignFlags) as ('left' | 'right')[]
    // Which measure columns can honestly total. Additive aggregates sum, and
    // so do 'latest' running figures: each row carries the END value of a
    // disjoint per-bucket series (one employee's component YTD), so the sum
    // of endings IS the combined ending. avg/min/max stay blank.
    const summable = measures.map(
      (m) => m.fn === 'sum' || m.fn === 'count' || m.fn === 'count_distinct' || m.fn === 'latest',
    )
    const totalLabel = (label: string) => labels.subtotal?.(label) ?? `${label} — total`
    // Subtotal level: the first breakout that ISN'T the section column.
    const levelIndex = breakouts.findIndex((_, i) => i !== sectionIndex)
    type Bucket = {
      rows: (string | number | null)[][]
      keys: (ReportRowScopeRule[] | null)[]
      raw: Record<string, unknown>[]
      totalRows: number[]
      dataCount: number
    }
    const buckets = new Map<string, Bucket>()
    dataRows.forEach((row, ri) => {
      const key = row[`d${sectionIndex}`] == null
        ? (labels.none?.() ?? '(none)')
        : String(rows[ri]![sectionIndex] ?? row[`d${sectionIndex}`])
      const bucket = buckets.get(key) ?? { rows: [], keys: [], raw: [], totalRows: [], dataCount: 0 }
      bucket.rows.push(drop(rows[ri]!) as (string | number | null)[])
      bucket.keys.push(rowKeys[ri] ?? null)
      bucket.raw.push(row)
      bucket.dataCount += 1
      buckets.set(key, bucket)
    })

    // Per-section subtotal rows on the level breakout (e.g. per component
    // KIND inside one employee's journal block) — exact decimal sums over the
    // raw aggregates, never over display strings.
    if (totals?.sections && levelIndex >= 0 && breakouts.length >= 2) {
      for (const bucket of buckets.values()) {
        const out: Bucket = { rows: [], keys: [], raw: [], totalRows: [], dataCount: bucket.dataCount }
        const levelPos = drop(breakouts.map((_, i) => i)).indexOf(levelIndex)
        let levelRaw: Record<string, unknown>[] = []
        let levelValue: string | null = null
        let levelDisplay: string | null = null
        const emit = () => {
          if (levelValue === null || levelRaw.length === 0) return
          const totalsRow = sectionColumns.map(() => null as string | number | null)
          totalsRow[levelPos] = totalLabel(levelDisplay ?? levelValue)
          measures.forEach((m, mi) => {
            if (!summable[mi]) return
            const inputs = levelRaw.map((raw) => raw[`m${mi}`])
            if (inputs.every((v) => v === null || v === undefined)) return
            const total = sumExactDecimals(inputs)
            totalsRow[breakouts.length - 1 + mi] = m.fn === 'sum' || m.fn === 'latest'
              ? (formatExactNumber(total) ?? total)
              : Number(total)
          })
          out.totalRows.push(out.rows.length)
          out.rows.push(totalsRow)
          out.keys.push(null)
        }
        bucket.rows.forEach((row, i) => {
          const value = String(bucket.raw[i]![`d${levelIndex}`] ?? (labels.none?.() ?? '(none)'))
          if (levelValue !== null && value !== levelValue) emit(), (levelRaw = [])
          levelValue = value
          // The DISPLAY value (humanized enum, formatted date) titles the row.
          levelDisplay = row[levelPos] == null ? null : String(row[levelPos])
          levelRaw.push(bucket.raw[i]!)
          out.rows.push(row)
          out.keys.push(bucket.keys[i] ?? null)
        })
        emit()
        bucket.rows = out.rows
        bucket.keys = out.keys
        bucket.totalRows = out.totalRows
      }
    }

    if (totals?.derived?.length) {
      const levelPos = Math.max(
        drop(breakouts.map((_, i) => i)).indexOf(breakouts.findIndex((_, i) => i !== sectionIndex)),
        0,
      )
      for (const bucket of buckets.values()) {
        for (const spec of totals.derived) {
          const row = buildDerivedRow(spec, bucket.raw, sectionColumns.length, levelPos, summable, breakouts.length - 1)
          if (!row) continue
          bucket.totalRows.push(bucket.rows.length)
          bucket.rows.push(row)
          bucket.keys.push(null)
        }
      }
    }

    groups = [...buckets.entries()].map(([key, bucket]) => ({
      kind: 'summary' as const,
      title: labels.sectionTitle?.(sectionLabel, formatLabel(key)) ?? `${sectionLabel}: ${formatLabel(key)}`,
      subtitle: labels.rowCount?.(bucket.dataCount) ?? `${bucket.dataCount} row(s)`,
      columns: sectionColumns,
      rows: bucket.rows,
      money: sectionMoney.some(Boolean) ? sectionMoney : undefined,
      align: sectionAlign,
      rowKeys: bucket.keys,
      ...(bucket.totalRows.length ? { totalRows: bucket.totalRows } : {}),
    }))

    // Grand totals across every section: one row per remaining-breakout combo.
    // Additive measures and 'latest' running figures sum exactly (disjoint
    // bucket endings add); avg/min/max stay blank — omission over a wrong number.
    if (totals?.grand) {
      const grand = new Map<string, { label: (string | number | null)[]; raw: Record<string, unknown>[]; scope: ReportRowScopeRule[] | null }>()
      dataRows.forEach((row, ri) => {
        const comboKey = breakouts.map((_, i) => (i === sectionIndex ? '' : String(row[`d${i}`] ?? ''))).join('\u0000')
        const entry = grand.get(comboKey) ?? {
          label: drop(rows[ri]!) as (string | number | null)[],
          raw: [],
          scope: (rowKeys[ri] ?? null)?.filter((s) => s.field !== breakouts[sectionIndex]!.column) ?? null,
        }
        entry.raw.push(row)
        grand.set(comboKey, entry)
      })
      const grandRows: (string | number | null)[][] = []
      const grandKeys: (ReportRowScopeRule[] | null)[] = []
      // Insertion order = the query's ledger order (enum dims by catalog).
      for (const entry of grand.values()) {
        const row = entry.label.slice(0, breakouts.length - 1) as (string | number | null)[]
        measures.forEach((m, mi) => {
          const inputs = entry.raw.map((raw) => raw[`m${mi}`])
          if (!summable[mi] || inputs.every((v) => v === null || v === undefined)) {
            row[breakouts.length - 1 + mi] = null
            return
          }
          const total = sumExactDecimals(inputs)
          row[breakouts.length - 1 + mi] = m.fn === 'sum' || m.fn === 'latest'
            ? (formatExactNumber(total) ?? total)
            : Number(total)
        })
        grandRows.push(row)
        grandKeys.push(entry.scope)
      }
      const grandTotalRows: number[] = []
      if (totals.derived?.length) {
        const levelPos = Math.max(
          drop(breakouts.map((_, i) => i)).indexOf(breakouts.findIndex((_, i) => i !== sectionIndex)),
          0,
        )
        for (const spec of totals.derived) {
          const row = buildDerivedRow(spec, dataRows, sectionColumns.length, levelPos, summable, breakouts.length - 1)
          if (!row) continue
          grandTotalRows.push(grandRows.length)
          grandRows.push(row)
          grandKeys.push(null)
        }
      }
      groups.push({
        kind: 'summary',
        title: labels.grandTotalsTitle?.() ?? 'Grand totals',
        subtitle: labels.groupCount?.(buckets.size) ?? `${buckets.size} group${buckets.size === 1 ? '' : 's'}`,
        columns: sectionColumns,
        rows: grandRows,
        money: sectionMoney.some(Boolean) ? sectionMoney : undefined,
        align: sectionAlign,
        rowKeys: grandKeys,
        ...(grandTotalRows.length ? { totalRows: grandTotalRows } : {}),
      })
    }
  } else {
    groups = [
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
        rowKeys,
      },
    ]
  }

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
        money: measureIsMoney(m),
      })
    }
  })

  return { groups, summary, rowCount: dataRows.length }
}

// --- value formatting ----------------------------------------------------------

/**
 * Inclusive [from, to] date bounds of one temporal bucket. The raw value is
 * the bucket START (date_trunc output, fiscal-shifted where applicable) — pg
 * hands date columns back as Date at LOCAL midnight, so local parts are the
 * truth (toISOString would shift a day east of UTC).
 */
function binRange(v: unknown, bin: ReportTemporalBin): { from: string; to: string } | null {
  let y: number, m: number, d: number
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null
    y = v.getFullYear(); m = v.getMonth(); d = v.getDate()
  } else {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v))
    if (!match) return null
    y = Number(match[1]); m = Number(match[2]) - 1; d = Number(match[3])
  }
  const start = new Date(Date.UTC(y, m, d))
  const end = new Date(start)
  switch (bin) {
    case 'day':
      break
    case 'week':
      end.setUTCDate(end.getUTCDate() + 6)
      break
    case 'month':
    case 'fiscal_period':
      end.setUTCMonth(end.getUTCMonth() + 1)
      end.setUTCDate(end.getUTCDate() - 1)
      break
    case 'quarter':
    case 'fiscal_quarter':
      end.setUTCMonth(end.getUTCMonth() + 3)
      end.setUTCDate(end.getUTCDate() - 1)
      break
    case 'year':
    case 'fiscal_year':
      end.setUTCMonth(end.getUTCMonth() + 12)
      end.setUTCDate(end.getUTCDate() - 1)
      break
    default:
      return null
  }
  return { from: isoDate(start), to: isoDate(end) }
}

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

/** Cell value for display: enum/boolean columns print humanised (underscores →
 *  spaces, true/false through the locale's yes/no), everything else through
 *  formatCustomValue. */
function formatCellValue(
  entity: ReportEntity,
  column: string,
  v: unknown,
  labels: ReportRunLabels = {},
): string | number | null {
  const kind = entityColumn(entity, column)?.kind
  if (kind === 'enum' || kind === 'boolean') {
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

/** a − b at combined scale, exact bigint decimals (reuses the sum machinery). */
function subtractExactDecimals(a: string, b: string): string {
  const negated = b.startsWith('-') ? b.slice(1) : `-${b}`
  return sumExactDecimals([a, negated])
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
