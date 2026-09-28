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
  isBaseMoneyMeasure,
  isMoneyBlendingMeasure,
  isSnapshotSum,
  isTxnCurrencyMeasure,
  labelFor,
  measureLabel,
  parseDenominationCounts,
  parseNormalizationCounts,
  REPORT_TOTAL_ROWS_COLUMN,
  resolveDenominations,
  resolveNormalization,
  type CompileCustomQueryOpts,
  type DenominationSingles,
} from './custom-query'
import {
  formatLabel,
  isoDate,
  pickUuid,
  type ReportBreakout,
  type ReportCellLink,
  type ReportCustomQuery,
  type ReportGroup,
  type ReportMeasure,
  type ReportRunResult,
  type ReportRowScopeRule,
  type ReportTemporalBin,
} from './types'
import { fiscalMonthOffset, fiscalYearOf, utcCivilDate } from './fiscal-calendar'
import { evaluateFormulaMeasures } from './formula'
import { validateReportMeasureSet } from './validate'

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
  /** Localized explanation used when a formula is undefined. */
  undefinedFormula?: () => string
  /** Localized total-row explanation for non-additive formula inputs. */
  notTotalled?: () => string
}

function formulaNotTotalledKeys(measures: readonly ReportMeasure[], totalable: readonly boolean[]): Set<string> {
  const keyIndex = new Map(measures.flatMap((measure, index) => measure.key ? [[measure.key, index] as const] : []))
  const cache = new Map<number, boolean>()
  const active = new Set<number>()
  const canTotal = (index: number): boolean => {
    if (cache.has(index)) return cache.get(index)!
    if (active.has(index)) return false
    const measure = measures[index]!
    if (measure.fn !== 'formula') return !!totalable[index]
    active.add(index)
    const refs: string[] = []
    const walk = (expr: NonNullable<ReportMeasure['expr']>) => {
      if ('ref' in expr) refs.push(expr.ref)
      else if ('op' in expr) { walk(expr.left); walk(expr.right) }
    }
    if (measure.expr) walk(measure.expr)
    const result = refs.every((key) => {
      const target = keyIndex.get(key)
      return target !== undefined && canTotal(target)
    })
    active.delete(index)
    cache.set(index, result)
    return result
  }
  return new Set(measures.flatMap((measure, index) =>
    measure.fn === 'formula' && !canTotal(index) && measure.key ? [measure.key] : [],
  ))
}

function formulaTotalValues(
  measures: readonly ReportMeasure[],
  aggregateValues: readonly unknown[],
  totalable: readonly boolean[],
  labels: ReportRunLabels,
): ReturnType<typeof evaluateFormulaMeasures> {
  return evaluateFormulaMeasures(measures, aggregateValues, formulaNotTotalledKeys(measures, totalable), {
    undefined: labels.undefinedFormula?.(),
    notTotalled: labels.notTotalled?.(),
  })
}

function totalComponents(
  raws: readonly Record<string, unknown>[],
  measures: readonly ReportMeasure[],
  formulaTotalable: readonly boolean[],
  names: (rows: Record<string, unknown>[]) => string[],
  entity: ReportEntity,
  breakouts: readonly ReportBreakout[],
): (string | null)[] {
  return measures.map((measure, index) => {
    if (measure.fn === 'formula' || !formulaTotalable[index]) return null
    return aggregateMeasureTotal(raws, index, measure, entity, breakouts, names)
  })
}

/** True when a sum/opening/closing summary card over this measure would blend
 *  money dishonestly: the denomination is observably mixed, or the caller
 *  flagged the contributing scope incomplete. Counts never blend. */
function isMoneySummaryOmitted(
  entity: ReportEntity,
  measure: ReportMeasure,
  singles: DenominationSingles,
  suppressMoney: boolean,
): boolean {
  if (measure.fn !== 'sum' && measure.fn !== 'opening' && measure.fn !== 'closing') return false
  if (suppressMoney && isMoneyBlendingMeasure(entity, measure)) return true
  if (isTxnCurrencyMeasure(entity, measure) && !singles.txn) return true
  if (isBaseMoneyMeasure(entity, measure) && !singles.base) return true
  if (isMoneyBlendingMeasure(entity, measure) && entity.bookScope && !singles.book) return true
  return false
}

/** True when a formula summary card is transitively derived from an omitted
 *  money total. A ratio over blended or partial money is no safer than the
 *  blended total itself, so the card is omitted with it. Formulas over safe
 *  inputs (counts, hours) are unaffected. */
function isMoneyDerivedFormulaOmitted(
  entity: ReportEntity,
  measures: readonly ReportMeasure[],
  index: number,
  singles: DenominationSingles,
  suppressMoney: boolean,
): boolean {
  const keyToIndex = new Map(measures.flatMap((measure, candidate) => measure.key ? [[measure.key, candidate] as const] : []))
  const visiting = new Set<number>()
  const dependsOnOmittedMoney = (candidate: number): boolean => {
    const measure = measures[candidate]!
    if (measure.fn !== 'formula') return isMoneySummaryOmitted(entity, measure, singles, suppressMoney)
    if (visiting.has(candidate)) return false
    visiting.add(candidate)
    const refs: string[] = []
    const walk = (expr: NonNullable<ReportMeasure['expr']>): void => {
      if ('ref' in expr) refs.push(expr.ref)
      else if ('op' in expr) { walk(expr.left); walk(expr.right) }
    }
    if (measure.expr) walk(measure.expr)
    const result = refs.some((key) => {
      const target = keyToIndex.get(key)
      return target !== undefined && dependsOnOmittedMoney(target)
    })
    visiting.delete(candidate)
    return result
  }
  return dependsOnOmittedMoney(index)
}

function writeFormulaTotals(
  entity: ReportEntity,
  row: (string | number | null)[],
  measures: readonly ReportMeasure[],
  visibleMeasureIndices: readonly number[],
  components: readonly unknown[],
  offset: number,
  formulaTotalable: readonly boolean[],
  labels: ReportRunLabels,
  undefinedCells: (string | null)[],
): void {
  const results = formulaTotalValues(measures, components, formulaTotalable, labels)
  results.forEach((result, index) => {
    if (measures[index]?.fn !== 'formula') return
    const visibleIndex = visibleMeasureIndices.indexOf(index)
    if (visibleIndex < 0) return
    const target = offset + visibleIndex
    if (result.undefinedLabel) {
      row[target] = result.undefinedLabel
      undefinedCells[target] = result.undefinedLabel
    } else {
      row[target] = result.value === null
        ? null
        : formatMeasureValue(entity, measures[index]!, result.value)
    }
  })
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

  const fiscalStartMonth = opts.fiscalStartMonth != null
    && opts.fiscalStartMonth >= 1
    && opts.fiscalStartMonth <= 12
    ? opts.fiscalStartMonth
    : 1
  const compiled = compileCustomQuery(entity, q, opts.orgId, {
    maxRows: opts.maxRows,
    fiscalStartMonth,
    asOf: opts.asOf,
    page: opts.page,
    allowedSubsidiaryIds: opts.allowedSubsidiaryIds,
    allowedBookIds: opts.allowedBookIds,
  })
  const labels = opts.labels ?? {}
  const { rows: rawRows } = await client.query(compiled.text, compiled.values)
  let rows = rawRows
  // Governed normalization census: validated BEFORE any shaping or return,
  // from the same statement that produced the rows. Empty scopes are honestly
  // empty; anything else incoherent throws here. Rows-mode hidden columns and
  // the sentinel never reach product output and never count as rows.
  let normTotal: number | null = null
  // Summarize mode carries inline refs only when a result row exists; an
  // empty scope is honestly empty and skips validation. Governed rows mode
  // always returns its sentinel carrier, so it always validates.
  if (compiled.hasNormalizationCensus && (rows.length > 0 || compiled.mode === 'rows')) {
    const counts = parseNormalizationCounts(rows.find((r) => r != null) ?? null)
    if (!counts) throw new Error('Report returned invalid normalization evidence')
    resolveNormalization(entity, counts)
    normTotal = counts.total
    if (compiled.mode === 'rows') {
      const present = compiled.normalizationPresentColumn ?? '__page_present'
      const hidden = new Set(compiled.normalizationHiddenColumns ?? [])
      rows = rows
        .filter((row) => Number(row?.[present]) === 1)
        .map((row) => {
          const clean: Record<string, unknown> = {}
          for (const [key, value] of Object.entries(row ?? {})) {
            if (!hidden.has(key)) clean[key] = value
          }
          return clean
        })
    }
  }

  let result: ReportRunResult
  if (compiled.mode === 'summarize') {
    for (const row of rows) {
      for (const dim of compiled.denominationDimensions ?? []) {
        const count = row[`__${dim}_n`]
        if (count == null || !Number.isSafeInteger(Number(count)) || Number(count) < 0) {
          throw new Error('Report returned invalid denomination evidence')
        }
      }
      if (compiled.denominationDimensions?.includes('book')) {
        const count = row.__book_group_n
        if (count == null || !Number.isSafeInteger(Number(count)) || Number(count) < 0) {
          throw new Error('Report returned invalid accounting-book evidence')
        }
        // Book names are not unique. Grouping by a shared label must never
        // silently merge two books even though it appears to be partitioned.
        if (Number(count) > 1) {
          throw new Error('Cannot aggregate rows that mix accounting books — group by Book code or Book (id)')
        }
      }
    }
    // The inline `__denom` census rides on the result rows: guard and result
    // derive from the same statement and snapshot. Enforcement throws before
    // any blended row or combined total is shaped.
    const singles: DenominationSingles = resolveDenominations(
      entity,
      compiled,
      compiled.hasDenominationCensus ? parseDenominationCounts(rows[0]) : {},
    )
    result = shapeSummarizeRows(
      entity, compiled.breakouts, compiled.measures, rows, labels,
      compiled.groupBy, compiled.totals ?? null, singles, fiscalStartMonth,
    )
  } else {
    result = shapeRowsResult(entity, compiled.columns, compiled.groupBy, rows, labels, q.columnLabels ?? undefined)
  }

  if (!compiled.page) return result
  let totalRows: number
  // Governed rows derive the page total from the same statement — no second
  // count query. Every other plan keeps its existing count behavior.
  if (normTotal != null) {
    totalRows = normTotal
  } else if (rows.length > 0) {
    totalRows = parseTotalRows(rows[0]?.[REPORT_TOTAL_ROWS_COLUMN])
  } else if (compiled.page.offset > 0) {
    if (!compiled.countText) throw new Error('Paged report query is missing its count probe')
    const count = await client.query(compiled.countText, compiled.values)
    totalRows = parseTotalRows(count.rows[0]?.[REPORT_TOTAL_ROWS_COLUMN])
  } else {
    totalRows = 0
  }
  return {
    ...result,
    pageInfo: {
      ...compiled.page,
      totalRows,
      hasNext: compiled.page.offset + rows.length < totalRows,
      hasPrevious: compiled.page.offset > 0 && totalRows > 0,
    },
  }
}

function parseTotalRows(value: unknown): number {
  const total = Number(value)
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error('Paged report returned an invalid total row count')
  }
  return total
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
  const cellLinkByColumn = new Map(
    (entity.cellLinks ?? [])
      .filter((link) => requestedColumns.includes(link.column))
      .map((link) => [link.column, link] as const),
  )
  const rowCellLinks = (row: Record<string, unknown>): (ReportCellLink | null)[] =>
    requestedColumns.map((column) => {
      const spec = cellLinkByColumn.get(column)
      // Do not create an invisible click target for a null/empty display cell.
      if (!spec || row[column] == null || String(row[column]).trim() === '') return null
      const docId = spec.docIdColumn ? pickUuid(row[spec.docIdColumn]) : null
      const entryId = pickUuid(row[spec.entryIdColumn]) ?? docId
      if (!entryId) return null
      const rawKind = spec.docKindColumn ? row[spec.docKindColumn] : null
      return {
        kind: 'transaction',
        entryId,
        docId,
        docKind: typeof rawKind === 'string' && rawKind ? rawKind : null,
      }
    })
  const linkedCells = (data: Record<string, unknown>[]) => {
    if (cellLinkByColumn.size === 0) return undefined
    const matrix = data.map(rowCellLinks)
    return matrix.some((row) => row.some(Boolean)) ? matrix : undefined
  }

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
        const cellLinks = linkedCells(list)
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
          ...(cellLinks ? { cellLinks } : {}),
        })
      }
    }
  } else {
    const cellLinks = linkedCells(dataRows)
    groups.push({
      kind: 'results',
      title: resultsTitle,
      subtitle: rowCount(dataRows.length),
      columns: columnLabels,
      rows: dataRows.map((row) => requestedColumns.map((c) => cell(c, row[c]))),
      isEmpty: dataRows.length === 0,
      money,
      align,
      ...(cellLinks ? { cellLinks } : {}),
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

export function shapeSummarizeRows(
  entity: ReportEntity,
  breakouts: NonNullable<ReportCustomQuery['breakouts']>,
  measures: NonNullable<ReportCustomQuery['measures']>,
  dataRows: Record<string, unknown>[],
  labels: ReportRunLabels,
  groupBy: string | null = null,
  totals: ReportCustomQuery['totals'] = null,
  singles: DenominationSingles = { txn: true, base: true, book: true },
  fiscalStartMonth = 1,
  summaryOpts: { suppressMoneySummaries?: boolean } = {},
): ReportRunResult {
  const suppressMoney = summaryOpts.suppressMoneySummaries === true
  const visibleMeasureIndices = measures.flatMap((measure, index) => measure.hidden ? [] : [index])
  const visibleMeasureIndex = new Map(visibleMeasureIndices.map((index, visibleIndex) => [index, visibleIndex]))
  const visibleMeasures = visibleMeasureIndices.map((index) => measures[index]!)
  const measureHeading = (m: (typeof measures)[number]) =>
    labels.measure?.(entity, m) ?? measureLabel(entity, m)
  const columns = [
    ...breakouts.map((b) => labels.breakout?.(entity, b) ?? breakoutLabel(entity, b)),
    ...visibleMeasures.map(measureHeading),
  ]
  const undefinedByRow = new Map<Record<string, unknown>, (string | null)[]>()
  dataRows.forEach((row) => {
    const undefinedCells = Array.from({ length: columns.length }, () => null as string | null)
    const formulaValues = evaluateFormulaMeasures(
      measures,
      measures.map((_, index) => row[`m${index}`]),
      new Set(),
      { undefined: labels.undefinedFormula?.(), notTotalled: labels.notTotalled?.() },
    )
    formulaValues.forEach((result, index) => {
      if (measures[index]?.fn !== 'formula') return
      const visibleIndex = visibleMeasureIndex.get(index)
      if (visibleIndex === undefined) return
      if (result.undefinedLabel) {
        row[`m${index}`] = result.undefinedLabel
        undefinedCells[breakouts.length + visibleIndex] = result.undefinedLabel
      } else {
        row[`m${index}`] = result.value
      }
    })
    undefinedByRow.set(row, undefinedCells)
  })
  const rowNames = new Map<Record<string, unknown>, string>(dataRows.map((row, index) => {
    const dimensions = breakouts.map((breakout, i) => {
      const value = formatBreakoutValue(row[`d${i}`], breakout.bin, fiscalStartMonth)
        ?? (row[`d${i}`] == null ? '(blank)' : String(row[`d${i}`]))
      return `${breakoutLabel(entity, breakout)}=${value}`
    })
    return [row, dimensions.length ? dimensions.join(', ') : `aggregate row ${index + 1}`]
  }))
  const namesForRows = (raws: Record<string, unknown>[]) =>
    raws.map((row) => rowNames.get(row) ?? 'aggregate row')
  const rows = dataRows.map((row) => [
    ...breakouts.map((b, i) =>
      b.bin
        ? formatBreakoutValue(row[`d${i}`], b.bin, fiscalStartMonth)
        : formatCellValue(entity, b.column, row[`d${i}`], labels),
    ),
    ...visibleMeasureIndices.map((i, visibleIndex) => undefinedByRow.get(row)?.[breakouts.length + visibleIndex]
      ?? formatMeasureValue(entity, measures[i]!, row[`m${i}`])),
  ])
  const formulaTotalable = measures.map((measure) =>
    measure.fn === 'sum' || measure.fn === 'count' || measure.fn === 'opening' || measure.fn === 'closing',
  )

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
    m.fn === 'formula' ? m.format === 'money' : m.fn !== 'count'
      && !!m.column
      && entity.columns.find((col) => col.key === m.column)?.kind === 'money'
  const moneyFlags = [...breakouts.map(() => false), ...visibleMeasures.map(measureIsMoney)]
  const alignFlags = [
    ...breakouts.map(() => 'left' as const),
    ...visibleMeasures.map(() => 'right' as const),
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
  ): { row: (string | number | null)[]; undefinedCells: (string | null)[] } | null => {
    const fieldIndex = breakouts.findIndex((b) => b.column === spec.plus.field && !b.bin)
    const minusIndex = spec.minus ? breakouts.findIndex((b) => b.column === spec.minus!.field && !b.bin) : fieldIndex
    if (fieldIndex < 0 || minusIndex < 0) return null
    const row = Array.from({ length: width }, () => null as string | number | null)
    row[labelPos] = spec.label
    const formulaComponents: (string | null)[] = measures.map(() => null)
    measures.forEach((m, mi) => {
      const visibleIndex = visibleMeasureIndex.get(mi)
      if (!summableFlags[mi]) return
      const plusRows = raws.filter((r) => String(r[`d${fieldIndex}`] ?? '') === spec.plus.value)
      const plusInputs = plusRows.map((r) => r[`m${mi}`])
      const minusRows = spec.minus
        ? raws.filter((r) => String(r[`d${minusIndex}`] ?? '') === spec.minus!.value)
        : []
      const minusInputs = minusRows.map((r) => r[`m${mi}`])
      if (plusInputs.every((v) => v == null) && minusInputs.every((v) => v == null)) return
      const plusTotal = aggregateMeasureTotal(plusRows, mi, m, entity, breakouts, namesForRows)
      const minusTotal = spec.minus ? aggregateMeasureTotal(minusRows, mi, m, entity, breakouts, namesForRows) : '0'
      const total = subtractExactDecimals(plusTotal, minusTotal)
      if (visibleIndex !== undefined) row[measureOffset + visibleIndex] = shapeTotalValue(m.fn, total)
      if (formulaTotalable[mi]) formulaComponents[mi] = total
    })
    const undefinedCells = Array.from({ length: width }, () => null as string | null)
    writeFormulaTotals(entity, row, measures, visibleMeasureIndices, formulaComponents, measureOffset, formulaTotalable, labels, undefinedCells)
    return { row, undefinedCells }
  }

  // Sectioned summarize: one titled group per bucket of the groupBy breakout
  // (the payroll journal's per-employee blocks), that column lifted out of the
  // table. Row scope keys stay COMPLETE so drills still hit the exact bucket.
  const sectionIndex = groupBy ? breakouts.findIndex((b) => b.column === groupBy) : -1
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
    // of endings IS the combined ending. A snapshot column never sums — each
    // row already carries the cumulative total, so the compiler refuses
    // sum-of-snapshot plans and totals stay blank here. avg/min/max stay
    // blank.
    const summable = measures.map(
      (m) => (m.fn === 'sum' || m.fn === 'count' || m.fn === 'latest' || m.fn === 'opening' || m.fn === 'closing') && !isSnapshotSum(entity, m),
    )
    const totalLabel = (label: string) => labels.subtotal?.(label) ?? `${label} — total`
    // Subtotal level: the first breakout that ISN'T the section column.
    const levelIndex = breakouts.findIndex((_, i) => i !== sectionIndex)
    type Bucket = {
      rows: (string | number | null)[][]
      undefinedCells: (string | null)[][]
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
      const bucket = buckets.get(key) ?? { rows: [], undefinedCells: [], keys: [], raw: [], totalRows: [], dataCount: 0 }
      bucket.rows.push(drop(rows[ri]!) as (string | number | null)[])
      bucket.undefinedCells.push(drop(undefinedByRow.get(row) ?? columns.map(() => null)) as (string | null)[])
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
        const out: Bucket = { rows: [], undefinedCells: [], keys: [], raw: [], totalRows: [], dataCount: bucket.dataCount }
        const levelPos = drop(breakouts.map((_, i) => i)).indexOf(levelIndex)
        let levelRaw: Record<string, unknown>[] = []
        let levelValue: string | null = null
        let levelDisplay: string | null = null
        const emit = () => {
          if (levelValue === null || levelRaw.length === 0) return
          const totalsRow = sectionColumns.map(() => null as string | number | null)
          totalsRow[levelPos] = totalLabel(levelDisplay ?? levelValue)
          measures.forEach((m, mi) => {
            const visibleIndex = visibleMeasureIndex.get(mi)
            if (!summable[mi]) return
            const inputs = levelRaw.map((raw) => raw[`m${mi}`])
            if (inputs.every((v) => v === null || v === undefined)) return
            const total = m.fn === 'opening' || m.fn === 'closing'
              ? aggregateMeasureTotal(levelRaw, mi, m, entity, breakouts, namesForRows)
              : sumExactDecimals(inputs, namesForRows(levelRaw))
            if (visibleIndex !== undefined) totalsRow[breakouts.length - 1 + visibleIndex] = shapeTotalValue(m.fn, total)
          })
          const components = totalComponents(levelRaw, measures, formulaTotalable, namesForRows, entity, breakouts)
          const totalUndefined = Array.from({ length: sectionColumns.length }, () => null as string | null)
          writeFormulaTotals(entity, totalsRow, measures, visibleMeasureIndices, components, breakouts.length - 1, formulaTotalable, labels, totalUndefined)
          out.totalRows.push(out.rows.length)
          out.rows.push(totalsRow)
          out.undefinedCells.push(totalUndefined)
          out.keys.push(null)
        }
        bucket.rows.forEach((row, i) => {
          const value = String(bucket.raw[i]![`d${levelIndex}`] ?? (labels.none?.() ?? '(none)'))
          if (levelValue !== null && value !== levelValue) { emit(); levelRaw = []; }
          levelValue = value
          // The DISPLAY value (humanized enum, formatted date) titles the row.
          levelDisplay = row[levelPos] == null ? null : String(row[levelPos])
          levelRaw.push(bucket.raw[i]!)
          out.rows.push(row)
          out.undefinedCells.push(bucket.undefinedCells[i]!)
          out.keys.push(bucket.keys[i] ?? null)
        })
        emit()
        bucket.rows = out.rows
        bucket.undefinedCells = out.undefinedCells
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
          const derived = buildDerivedRow(spec, bucket.raw, sectionColumns.length, levelPos, summable, breakouts.length - 1)
          if (!derived) continue
          bucket.totalRows.push(bucket.rows.length)
          bucket.rows.push(derived.row)
          bucket.undefinedCells.push(derived.undefinedCells)
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
      undefinedCells: bucket.undefinedCells,
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
      const grandUndefinedCells: (string | null)[][] = []
      const timeSection = breakouts[sectionIndex]?.column === entity.timeKey
      // Insertion order = the query's ledger order (enum dims by catalog).
      for (const entry of grand.values()) {
        const row = entry.label.slice(0, breakouts.length - 1) as (string | number | null)[]
        const formulaComponents: (string | null)[] = measures.map(() => null)
        const orderedRaw = timeSection
          ? [...entry.raw].sort((left, right) => comparableTime(left[`d${sectionIndex}`]).localeCompare(comparableTime(right[`d${sectionIndex}`])))
          : entry.raw
        measures.forEach((m, mi) => {
          const visibleIndex = visibleMeasureIndex.get(mi)
          const inputs = timeSection && (m.fn === 'opening' || m.fn === 'closing')
            ? [orderedRaw[m.fn === 'opening' ? 0 : orderedRaw.length - 1]?.[`m${mi}`]]
            : entry.raw.map((raw) => raw[`m${mi}`])
          if (!summable[mi] || inputs.every((v) => v === null || v === undefined)) {
            if (visibleIndex !== undefined) row[breakouts.length - 1 + visibleIndex] = null
            return
          }
          const total = (m.fn === 'opening' || m.fn === 'closing') && !timeSection
            ? aggregateMeasureTotal(entry.raw, mi, m, entity, breakouts, namesForRows)
            : sumExactDecimals(inputs, namesForRows(entry.raw))
          if (visibleIndex !== undefined) row[breakouts.length - 1 + visibleIndex] = shapeTotalValue(m.fn, total)
          if (formulaTotalable[mi]) formulaComponents[mi] = total
        })
        const undefinedCells = Array.from({ length: sectionColumns.length }, () => null as string | null)
        writeFormulaTotals(entity, row, measures, visibleMeasureIndices, formulaComponents, breakouts.length - 1, formulaTotalable, labels, undefinedCells)
        grandRows.push(row)
        grandUndefinedCells.push(undefinedCells)
        grandKeys.push(entry.scope)
      }
      const grandTotalRows: number[] = []
      if (totals.derived?.length) {
        const levelPos = Math.max(
          drop(breakouts.map((_, i) => i)).indexOf(breakouts.findIndex((_, i) => i !== sectionIndex)),
          0,
        )
        for (const spec of totals.derived) {
          const derived = buildDerivedRow(spec, dataRows, sectionColumns.length, levelPos, summable, breakouts.length - 1)
          if (!derived) continue
          grandTotalRows.push(grandRows.length)
          grandRows.push(derived.row)
          grandUndefinedCells.push(derived.undefinedCells)
          grandKeys.push(null)
        }
      }
      groups.push({
        kind: 'summary',
        title: labels.grandTotalsTitle?.() ?? 'Grand totals',
        subtitle: labels.groupCount?.(buckets.size) ?? `${buckets.size} group${buckets.size === 1 ? '' : 's'}`,
        columns: sectionColumns,
        rows: grandRows,
        undefinedCells: grandUndefinedCells,
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
        undefinedCells: dataRows.map((row) => undefinedByRow.get(row) ?? columns.map(() => null)),
        isEmpty: dataRows.length === 0,
        money: moneyFlags.some(Boolean) ? moneyFlags : undefined,
        rowKeys,
      },
    ]
  }

  // Grand totals for count/sum measures make useful summary cards — except a
  // sum whose denomination is observably mixed (transaction currencies,
  // functional bases, or accounting books), which would add foreign money
  // together. Partitioned group rows stay; the mixed card is omitted (no row
  // beats a wrong row).
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
    if (m.hidden) return
    if (isMoneySummaryOmitted(entity, m, singles, suppressMoney)) return
    // A snapshot card never sums: the compiler refuses sum-of-snapshot plans,
    // and a total here would multiply every movement by its stub count.
    if (m.fn === 'count' || m.fn === 'sum' || m.fn === 'opening' || m.fn === 'closing') {
      const total = aggregateMeasureTotal(dataRows, i, m, entity, breakouts, namesForRows)
      summary.push({
        label:
          labels.summaryTotal?.(measureHeading(m)) ??
          `Total ${measureLabel(entity, m).toLowerCase()}`,
        value: m.fn === 'count' ? Number(total) : formatExactNumber(total) ?? total,
        money: measureIsMoney(m),
      })
    }
  })

  const summaryComponents = measures.map((measure, index) =>
    measure.fn !== 'formula' && formulaTotalable[index]
      ? aggregateMeasureTotal(dataRows, index, measure, entity, breakouts, namesForRows)
      : null,
  )
  const summaryFormulaValues = formulaTotalValues(measures, summaryComponents, formulaTotalable, labels)
  summaryFormulaValues.forEach((result, index) => {
    if (measures[index]?.fn !== 'formula' || measures[index]?.hidden) return
    // A computed refusal still speaks: a guard that fires (nothing priced, no
    // capacity) publishes its named label even while unsafe totals stay
    // omitted. Only a would-be VALUE over omitted money is suppressed.
    if (result.undefinedLabel == null && isMoneyDerivedFormulaOmitted(entity, measures, index, singles, suppressMoney)) return
    const measure = measures[index]!
    summary.push({
      label: labels.summaryTotal?.(measureHeading(measure)) ?? `Total ${measureHeading(measure).toLowerCase()}`,
      value: result.undefinedLabel ?? (result.value === null
        ? labels.undefinedFormula?.() ?? 'Undefined — divides by zero'
        : formatMeasureValue(entity, measure, result.value) ?? result.value),
      money: measure.format === 'money',
    })
  })

  return { groups, summary, rowCount: dataRows.length }
}

export type InMemoryReportMeasure = Omit<ReportMeasure, 'filter'> & {
  /** Trusted engine predicate applied before this aggregate is calculated. */
  filter?: (row: Readonly<Record<string, unknown>>) => boolean
}

/** Reusable completeness contract for an in-memory report plan. A plan whose
 *  combined monetary summary is honest only when every contributing row is
 *  fully resolved declares that row test here; the shared shaper omits
 *  monetary and money-derived formula summary cards while any contributor is
 *  incomplete. Counts, hours, group rows, and computed refusals are kept. */
export type InMemorySummaryPolicy = {
  /** True for a contributing input row whose pricing or costing is unresolved. */
  incompleteRow?: (row: Readonly<Record<string, unknown>>) => boolean
}

export type SummarizeRowsPlan = {
  entity: ReportEntity
  breakouts: ReportBreakout[]
  measures: InMemoryReportMeasure[]
  /** Time column used by opening and closing; defaults to entity.timeKey. */
  timeKey?: string
  groupBy?: string | null
  totals?: ReportCustomQuery['totals']
  fiscalStartMonth?: number
  labels?: ReportRunLabels
  /** Optional completeness contract for the summary band. */
  summaryPolicy?: InMemorySummaryPolicy
}

/** Pure producer for trusted, engine-computed facts. The returned dN/mN rows
 *  have the same aliases and decimal-string representation as the SQL path. */
export function summarizeRows(
  inputRows: readonly Readonly<Record<string, unknown>>[],
  plan: SummarizeRowsPlan,
): Record<string, unknown>[] {
  const timeKey = plan.timeKey ?? plan.entity.timeKey
  const entity = { ...plan.entity, timeKey }
  const reportMeasures = plan.measures.map(({ filter: _predicate, ...measure }) => measure)
  validateReportMeasureSet(entity, reportMeasures)
  const fiscalStartMonth = plan.fiscalStartMonth != null
    && plan.fiscalStartMonth >= 1
    && plan.fiscalStartMonth <= 12
    ? plan.fiscalStartMonth
    : 1
  const groups = new Map<string, { dimensions: unknown[]; rows: readonly Readonly<Record<string, unknown>>[] }>()
  const mutableGroups = new Map<string, { dimensions: unknown[]; rows: Readonly<Record<string, unknown>>[] }>()

  if (plan.breakouts.length === 0) mutableGroups.set('[]', { dimensions: [], rows: [] })

  for (const row of inputRows) {
    const dimensions = plan.breakouts.map((breakout) => memoryDimension(row[breakout.column], breakout, fiscalStartMonth))
    const key = JSON.stringify(dimensions.map(stableMemoryValue))
    const bucket = mutableGroups.get(key) ?? { dimensions, rows: [] }
    bucket.rows.push(row)
    mutableGroups.set(key, bucket)
  }

  // Match the report SQL's user-visible ordering: a sectioned enum follows its
  // catalog order, date bins are chronological, and other summaries rank by
  // the first measure descending.
  const buckets = [...mutableGroups.values()]
  const sectionIndex = plan.groupBy
    ? plan.breakouts.findIndex((breakout) => breakout.column === plan.groupBy)
    : -1
  if (sectionIndex >= 0 && plan.breakouts[sectionIndex]) {
    buckets.sort((left, right) => {
      for (const [index, breakout] of plan.breakouts.entries()) {
        const column = entity.columns.find((candidate) => candidate.key === breakout.column)
        const a = left.dimensions[index]
        const b = right.dimensions[index]
        if (a == null || b == null) {
          if (a == null && b != null) return 1
          if (a != null && b == null) return -1
          continue
        }
        if (!breakout.bin && (column?.kind === 'enum' || column?.kind === 'boolean') && column.options?.length) {
          const rank = new Map(column.options.map((value, optionIndex) => [value, optionIndex]))
          const order = (rank.get(String(a)) ?? Number.MAX_SAFE_INTEGER) - (rank.get(String(b)) ?? Number.MAX_SAFE_INTEGER)
          if (order) return order
        } else {
          const order = String(a).localeCompare(String(b))
          if (order) return order
        }
      }
      return 0
    })
  } else if (plan.breakouts[0]?.bin) {
    buckets.sort((left, right) => String(left.dimensions[0] ?? '').localeCompare(String(right.dimensions[0] ?? '')))
  } else if (plan.breakouts.length > 0) {
    buckets.sort((left, right) => {
      const leftTotal = inMemorySortValue(left.rows, plan.measures, timeKey)
      const rightTotal = inMemorySortValue(right.rows, plan.measures, timeKey)
      return compareDecimals(rightTotal, leftTotal)
        || JSON.stringify(left.dimensions).localeCompare(JSON.stringify(right.dimensions))
    })
  }

  for (const bucket of buckets) groups.set(JSON.stringify(bucket.dimensions.map(stableMemoryValue)), bucket)
  return [...groups.values()].map((bucket) => {
    const raw: Record<string, unknown> = {}
    bucket.dimensions.forEach((value, index) => { raw[`d${index}`] = value })
    plan.measures.forEach((measure, index) => {
      raw[`m${index}`] = measure.fn === 'formula'
        ? null
        : aggregateInMemoryMeasure(bucket.rows, measure, timeKey)
    })
    return raw
  })
}

/** Per-denomination singularity observed across the contributing in-memory
 *  input rows. Each declared currency dimension (transaction, functional
 *  base, accounting book) is judged independently from the actual row values
 *  the caller contributes — never from group keys and never assumed. An
 *  undeclared dimension is single by construction; a declared dimension with
 *  no contributors is vacuously single. With contributors, any missing,
 *  null, undefined, or blank value fails closed, one shared nonblank value
 *  stays single, and two values are mixed. */
export function resolveInMemorySingles(
  entity: ReportEntity,
  inputRows: readonly Readonly<Record<string, unknown>>[],
): DenominationSingles {
  const observed = (column: string | null | undefined): boolean => {
    if (column === undefined) return true
    if (inputRows.length === 0) return true
    if (column === null) return false
    const values = new Set<string>()
    for (const row of inputRows) {
      const value = row[column]
      if (value === null || value === undefined) return false
      const text = typeof value === 'string' ? value : String(value)
      if (text.trim() === '') return false
      values.add(text)
      if (values.size > 1) return false
    }
    return true
  }
  // The accounting book is observed through the canonical public row key,
  // never through bookScope.column: that is a SQL expression over table
  // aliases (je.book_id), not a record key. A catalog invariant pins that
  // every book-scoped entity exposes book_id; a scoped entity without it
  // cannot prove one book and fails closed.
  const bookColumn = !entity.bookScope
    ? undefined
    : (entity.columns ?? []).some((column) => column.key === 'book_id')
      ? 'book_id'
      : null
  return {
    txn: observed(entity.currencyColumn),
    base: observed(entity.baseCurrencyColumn),
    book: observed(bookColumn),
  }
}

/** Produce the complete shared result shape for in-memory facts. The caller
 *  contributes the input rows its aggregates were built from so denomination
 *  singularity and the plan's completeness policy are observed from real
 *  values. Aggregates without contributors are vacuous and stay single;
 *  aggregates WITHHELD from observation fail closed and omit money cards. */
export function shapeSummarizedRows(
  rows: Record<string, unknown>[],
  plan: SummarizeRowsPlan,
  inputRows: readonly Readonly<Record<string, unknown>>[] = [],
): ReportRunResult {
  const entity = { ...plan.entity, timeKey: plan.timeKey ?? plan.entity.timeKey }
  const measures = plan.measures.map(({ filter: _predicate, ...measure }) => measure)
  const singles = inputRows.length > 0 || rows.length === 0
    ? resolveInMemorySingles(entity, inputRows)
    : { txn: false, base: false, book: false }
  const incomplete = plan.summaryPolicy?.incompleteRow
    ? inputRows.some((row) => plan.summaryPolicy!.incompleteRow!(row))
    : false
  return shapeSummarizeRows(
    entity,
    plan.breakouts,
    measures,
    rows.map((row) => ({ ...row })),
    plan.labels ?? {},
    plan.groupBy ?? null,
    plan.totals ?? null,
    singles,
    plan.fiscalStartMonth ?? 1,
    { suppressMoneySummaries: incomplete },
  )
}

function aggregateInMemoryMeasure(
  rows: readonly Readonly<Record<string, unknown>>[],
  measure: InMemoryReportMeasure,
  timeKey?: string,
): string | number | null {
  let selected = rows.filter((row) => !measure.filter || measure.filter(row))
  if (measure.fn === 'opening' || measure.fn === 'closing') {
    if (!timeKey) throw new Error(`Measure '${measure.key ?? measure.label ?? measure.fn}' requires a time key`)
    const values = rows.map((row) => memoryTime(row[timeKey])).filter(Boolean).sort()
    const boundary = measure.fn === 'opening' ? values[0] : values[values.length - 1]
    selected = boundary === undefined ? [] : selected.filter((row) => memoryTime(row[timeKey]) === boundary)
  }
  if (measure.fn === 'count') return selected.length
  if (measure.fn === 'count_distinct') {
    const unique = new Set(selected.map((row) => row[measure.column ?? '']).filter((value) => value != null).map(stableMemoryValue))
    return unique.size
  }
  if (measure.fn === 'formula') return null
  if (measure.fn !== 'sum' && measure.fn !== 'opening' && measure.fn !== 'closing') {
    throw new Error(`In-memory summaries do not support '${measure.fn}' measures`)
  }
  return sumExactDecimals(selected.map((row) => row[measure.column ?? '']))
}

function inMemorySortValue(
  rows: readonly Readonly<Record<string, unknown>>[],
  measures: readonly InMemoryReportMeasure[],
  timeKey?: string,
): string | number | null {
  const aggregateValues = measures.map((measure) => measure.fn === 'formula'
    ? null
    : aggregateInMemoryMeasure(rows, measure, timeKey))
  const reportMeasures = measures.map(({ filter: _predicate, ...measure }) => measure)
  const formulaValues = evaluateFormulaMeasures(reportMeasures, aggregateValues)
  return measures[0]?.fn === 'formula'
    ? formulaValues[0]?.value ?? null
    : aggregateValues[0] as string | number | null
}

function memoryDimension(value: unknown, breakout: ReportBreakout, fiscalStartMonth: number): unknown {
  if (!breakout.bin || value == null) return value ?? null
  const raw = memoryTime(value)
  if (!raw) return null
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return null
  if (breakout.bin.startsWith('fiscal_')) {
    date.setUTCMonth(date.getUTCMonth() - (fiscalStartMonth - 1))
  }
  switch (breakout.bin) {
    case 'week': {
      const day = date.getUTCDay()
      date.setUTCDate(date.getUTCDate() - ((day + 6) % 7))
      break
    }
    case 'day': break
    case 'month': case 'fiscal_period': date.setUTCDate(1); break
    case 'quarter': case 'fiscal_quarter': date.setUTCMonth(Math.floor(date.getUTCMonth() / 3) * 3, 1); break
    case 'year': case 'fiscal_year': date.setUTCMonth(0, 1); break
  }
  date.setUTCHours(0, 0, 0, 0)
  if (breakout.bin.startsWith('fiscal_')) date.setUTCMonth(date.getUTCMonth() + (fiscalStartMonth - 1))
  return date.toISOString()
}

function memoryTime(value: unknown): string {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString()
  if (value == null) return ''
  const text = String(value)
  const dateText = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00.000Z` : text
  const date = new Date(dateText)
  return Number.isNaN(date.getTime()) ? text : date.toISOString()
}

function stableMemoryValue(value: unknown): string | number | boolean | null {
  if (value instanceof Date) return memoryTime(value)
  if (value == null) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  return String(value)
}

function compareDecimals(left: string | number | null, right: string | number | null): number {
  if (left == null) return right == null ? 0 : 1
  if (right == null) return -1
  const a = decimalParts(left)
  const b = decimalParts(right)
  if (!a || !b) return String(left).localeCompare(String(right))
  const scale = Math.max(a.scale, b.scale)
  const av = a.units * 10n ** BigInt(scale - a.scale)
  const bv = b.units * 10n ** BigInt(scale - b.scale)
  return av < bv ? -1 : av > bv ? 1 : 0
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
  // utcCivilDate keeps literal years 0001-0099 that Date.UTC would remap onto 1900-1999.
  const start = utcCivilDate(y, m, d)
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
function formatBreakoutValue(v: unknown, bin?: ReportTemporalBin, fiscalStartMonth = 1): string | number | null {
  if (!bin) return formatCustomValue(v)
  if (v === null || typeof v === 'undefined') return null
  const iso = v instanceof Date ? v.toISOString() : String(v)
  switch (bin) {
    case 'fiscal_year': {
      const dateIso = v instanceof Date
        ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
        : iso.slice(0, 10)
      return `FY ${fiscalYearOf(dateIso, fiscalStartMonth)}`
    }
    case 'fiscal_quarter':
    case 'fiscal_period': {
      const dateIso = v instanceof Date
        ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
        : iso.slice(0, 10)
      const fiscalYear = fiscalYearOf(dateIso, fiscalStartMonth)
      const offset = fiscalMonthOffset(dateIso, fiscalStartMonth)
      return bin === 'fiscal_quarter'
        ? `Q${Math.floor(offset / 3) + 1} FY ${fiscalYear}`
        : `P${offset + 1} FY ${fiscalYear}`
    }
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

function sumExactDecimals(values: unknown[], rowNames: string[] = values.map((_, index) => `row ${index + 1}`)): string {
  const parts: { units: bigint; scale: number }[] = []
  values.forEach((value, index) => {
    if (value === null || typeof value === 'undefined') return
    const part = decimalParts(value)
    if (!part) {
      throw new Error(`Report total is incomplete: invalid numeric value in ${rowNames[index] ?? `row ${index + 1}`}`)
    }
    parts.push(part)
  })
  const scale = parts.reduce((maximum, part) => Math.max(maximum, part.scale), 0)
  const units = parts.reduce((total, part) => total + part.units * 10n ** BigInt(scale - part.scale), 0n)
  const negative = units < 0n
  const absolute = negative ? -units : units
  if (scale === 0) return `${negative ? '-' : ''}${absolute}`
  const digits = absolute.toString().padStart(scale + 1, '0')
  return `${negative ? '-' : ''}${digits.slice(0, -scale)}.${digits.slice(-scale)}`
}

function aggregateMeasureTotal(
  raws: readonly Record<string, unknown>[],
  index: number,
  measure: ReportMeasure,
  entity: ReportEntity,
  breakouts: readonly ReportBreakout[],
  names: (rows: Record<string, unknown>[]) => string[],
): string {
  let selected = [...raws]
  const timeIndex = measure.fn === 'opening' || measure.fn === 'closing'
    ? breakouts.findIndex((breakout) => breakout.column === entity.timeKey)
    : -1
  if (timeIndex >= 0) {
    const groups = new Map<string, Record<string, unknown>[]>()
    for (const row of selected) {
      const key = breakouts.map((_, dim) => dim === timeIndex ? '' : String(row[`d${dim}`] ?? '')).join('\u0000')
      const bucket = groups.get(key) ?? []
      bucket.push(row)
      groups.set(key, bucket)
    }
    selected = []
    for (const bucket of groups.values()) {
      const times = bucket.map((row) => comparableTime(row[`d${timeIndex}`])).filter(Boolean).sort()
      const boundary = measure.fn === 'opening' ? times[0] : times[times.length - 1]
      if (boundary !== undefined) selected.push(...bucket.filter((row) => comparableTime(row[`d${timeIndex}`]) === boundary))
    }
  }
  return sumExactDecimals(selected.map((row) => row[`m${index}`]), names(selected))
}

function comparableTime(value: unknown): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return ''
    return `${String(value.getFullYear()).padStart(4, '0')}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}T${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}:${String(value.getSeconds()).padStart(2, '0')}`
  }
  return value == null ? '' : String(value)
}

/**
 * Display value for a combined total over exact-decimal inputs. Counts are
 * true integers; every other aggregate keeps its exact decimal string —
 * routing a monetary total through Number would silently round past
 * IEEE-754 precision, so only counts take the Number path.
 */
function shapeTotalValue(fn: string, total: string): string | number {
  if (fn === 'count') return Number(total)
  return formatExactNumber(total) ?? total
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

/**
 * Display value for a summarize-mode measure. Date-kind source columns
 * (min/max/latest of a date) render as calendar dates — the kind-blind
 * fallback printed Date objects as datetimes ("2026-06-30 04:00:00", a UTC
 * rendering of a local-midnight date; F-t07-007). Every other measure keeps
 * the exact shaping it has today.
 */
export function formatMeasureValue(
  entity: ReportEntity,
  measure: Pick<ReportMeasure, 'column' | 'fn' | 'label' | 'format'>,
  v: unknown,
): string | number | null {
  if (measure.fn === 'formula') {
    const value = formatCustomValue(v)
    if (value === null || measure.format !== 'percent') return value
    return `${value}%`
  }
  const kind = measure.column ? entityColumn(entity, measure.column)?.kind : undefined
  if (kind !== 'date') return formatCustomValue(v)
  if (v === null || typeof v === 'undefined') return null
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null
    const mm = String(v.getMonth() + 1).padStart(2, '0')
    const dd = String(v.getDate()).padStart(2, '0')
    return `${v.getFullYear()}-${mm}-${dd}`
  }
  return String(v).slice(0, 10)
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
