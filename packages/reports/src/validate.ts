// Server-side sanitiser for untrusted customQuery payloads. Client JSON is untrusted: entity/columns/
// operators must resolve through the catalog, the filter tree is depth/size-
// capped, and aggregation specs are normalised. Shared by the definitions
// CRUD routes and the run/preview route.

import { REPORT_ENTITY_MAP, entityColumn, type ReportEntity } from './entities'
import { isMoneyBlendingMeasure, normalizeReportLimit } from './custom-query'
import {
  REPORT_AGG_FNS,
  REPORT_FILTER_OPERATORS,
  REPORT_TEMPORAL_BINS,
  resolveReportLayout,
  type ReportBreakout,
  type ReportCustomQuery,
  type ReportLayoutConfig,
  type ReportMeasure,
  type ReportFormulaExpr,
  type ReportRule,
  type ReportRuleGroup,
} from './types'

const MAX_DEPTH = 5
const MAX_RULES = 60
const MAX_BREAKOUTS = 6
const MAX_MEASURES = 8
const MAX_SORT_LEVELS = 3
const MAX_LABEL_LEN = 80
const MAX_FORMULA_DEPTH = 12

function sanitizeFormulaExpr(raw: unknown, measureKey: string, depth = 0): ReportFormulaExpr {
  if (depth > MAX_FORMULA_DEPTH || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ReportQueryValidationError(`Formula measure '${measureKey}' has an invalid expression`)
  }
  const expr = raw as Record<string, unknown>
  if (Object.keys(expr).length === 1 && typeof expr.ref === 'string' && expr.ref.trim()) {
    return { ref: expr.ref.trim() }
  }
  if (Object.keys(expr).length === 1 && typeof expr.const === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(expr.const)) {
    return { const: expr.const }
  }
  if (Object.keys(expr).length === 3 && ['+', '-', '*', '/'].includes(String(expr.op))) {
    return {
      op: expr.op as '+' | '-' | '*' | '/',
      left: sanitizeFormulaExpr(expr.left, measureKey, depth + 1),
      right: sanitizeFormulaExpr(expr.right, measureKey, depth + 1),
    }
  }
  throw new ReportQueryValidationError(`Formula measure '${measureKey}' has an invalid expression`)
}

function formulaRefs(expr: ReportFormulaExpr): string[] {
  if ('ref' in expr) return [expr.ref]
  if ('const' in expr) return []
  return [...formulaRefs(expr.left), ...formulaRefs(expr.right)]
}

function validateFormulaMeasures(entity: ReportEntity, measures: readonly ReportMeasure[]): void {
  const byKey = new Map<string, ReportMeasure>()
  for (const measure of measures) {
    if (measure.key) {
      if (byKey.has(measure.key)) throw new ReportQueryValidationError(`Duplicate measure key '${measure.key}'`)
      byKey.set(measure.key, measure)
    }
    if ((measure.fn === 'opening' || measure.fn === 'closing') && !entity.timeKey) {
      throw new ReportQueryValidationError(`Measure '${measure.key ?? measure.label ?? measure.column ?? measure.fn}' uses ${measure.fn}, but '${entity.key}' has no time key`)
    }
    if ((measure.fn === 'opening' || measure.fn === 'closing') && !entity.columns.some((column) => column.key === entity.timeKey)) {
      throw new ReportQueryValidationError(`Measure '${measure.key ?? measure.label ?? measure.column ?? measure.fn}' uses ${measure.fn}, but '${entity.key}' has an invalid time key`)
    }
  }
  const units = new Map<string, 'money' | 'ratio' | 'number'>()
  const active = new Set<string>()
  const unitOf = (key: string, owner: string): 'money' | 'ratio' | 'number' => {
    const measure = byKey.get(key)
    if (!measure) throw new ReportQueryValidationError(`Formula measure '${owner}' references unknown measure '${key}'`)
    if (units.has(key)) return units.get(key)!
    if (active.has(key)) throw new ReportQueryValidationError(`Formula measure '${owner}' forms a cycle through '${key}'`)
    active.add(key)
    let unit: 'money' | 'ratio' | 'number'
    if (measure.fn !== 'formula') {
      unit = measure.fn !== 'count' && measure.fn !== 'count_distinct'
        && measure.column && entity.columns.find((column) => column.key === measure.column)?.kind === 'money'
        ? 'money'
        : 'number'
    } else {
      if (!measure.expr || !measure.format) throw new ReportQueryValidationError(`Formula measure '${key}' requires an expression and format`)
      const exprUnit = (expr: ReportFormulaExpr): 'money' | 'ratio' | 'number' => {
        if ('ref' in expr) return unitOf(expr.ref, key)
        if ('const' in expr) return 'number'
        const left = exprUnit(expr.left)
        const right = exprUnit(expr.right)
        if (expr.op === '+' || expr.op === '-') {
          if (left !== right) throw new ReportQueryValidationError(`Formula measure '${key}' cannot ${expr.op === '+' ? 'add' : 'subtract'} ${left} and ${right} measures`)
          return left
        }
        if (expr.op === '*') {
          if (left === 'money' && right === 'money') throw new ReportQueryValidationError(`Formula measure '${key}' cannot multiply money by money`)
          if (left === 'money' || right === 'money') return 'money'
          return left === 'ratio' || right === 'ratio' ? 'ratio' : 'number'
        }
        if (left === 'money' && right === 'money') return 'ratio'
        if (left === 'money') return 'money'
        if (right === 'money') throw new ReportQueryValidationError(`Formula measure '${key}' cannot divide a non-money measure by money`)
        return 'ratio'
      }
      const resultUnit = exprUnit(measure.expr)
      const formatUnit = measure.format === 'money' ? 'money' : measure.format === 'number' ? 'number' : 'ratio'
      if (resultUnit !== formatUnit) throw new ReportQueryValidationError(`Formula measure '${key}' has ${resultUnit} inputs and must use the ${resultUnit} format`)
      unit = resultUnit
      for (const ref of formulaRefs(measure.expr)) unitOf(ref, key)
      for (const guard of measure.guards ?? []) {
        if (!byKey.has(guard.measure)) throw new ReportQueryValidationError(`Formula measure '${key}' has a guard for unknown measure '${guard.measure}'`)
      }
    }
    active.delete(key)
    units.set(key, unit)
    return unit
  }

  for (const measure of measures) {
    if (measure.fn !== 'formula') continue
    const key = measure.key ?? measure.label ?? 'unnamed formula'
    if (!measure.key || !measure.label || !measure.expr || !['ratio', 'percent', 'money', 'number'].includes(String(measure.format))) {
      throw new ReportQueryValidationError(`Formula measure '${key}' requires a key, label, expression and format`)
    }
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(measure.key)) {
      throw new ReportQueryValidationError(`Formula measure '${key}' has an invalid key`)
    }
    if (measure.scale !== undefined && (!Number.isInteger(measure.scale) || measure.scale < 0 || measure.scale > 12)) {
      throw new ReportQueryValidationError(`Formula measure '${key}' has an invalid scale`)
    }
    if (measure.undefinedLabel !== undefined && (!measure.undefinedLabel.trim() || measure.undefinedLabel.length > 120)) {
      throw new ReportQueryValidationError(`Formula measure '${key}' has an invalid undefined label`)
    }
    for (const ref of formulaRefs(measure.expr)) unitOf(ref, key)
    unitOf(measure.key, key)
    for (const guard of measure.guards ?? []) {
      if (!['zero', 'null'].includes(guard.when) || !guard.label.trim()) {
        throw new ReportQueryValidationError(`Formula measure '${key}' has an invalid guard`)
      }
    }
  }

  const denominationKinds = (key: string, activeDenominations = new Set<string>()): Set<string> => {
    if (activeDenominations.has(key)) return new Set()
    const measure = byKey.get(key)
    if (!measure) return new Set()
    if (measure.fn === 'formula') {
      const nested = new Set(activeDenominations).add(key)
      const kinds = new Set<string>()
      for (const ref of formulaRefs(measure.expr!)) {
        for (const kind of denominationKinds(ref, nested)) kinds.add(kind)
      }
      return kinds
    }
    if (!isMoneyBlendingMeasure(entity, measure)) return new Set()
    const column = entity.columns.find((candidate) => candidate.key === measure.column)
    if (!column) return new Set()
    return new Set([column.txnCurrency ? 'transaction currency' : column.baseMoney ? 'functional currency' : 'money'])
  }
  for (const measure of measures) {
    if (measure.fn !== 'formula' || !measure.key) continue
    const kinds = new Set<string>()
    for (const ref of formulaRefs(measure.expr!)) {
      for (const kind of denominationKinds(ref)) kinds.add(kind)
    }
    if (kinds.size > 1) {
      throw new ReportQueryValidationError(`Formula measure '${measure.key}' combines money inputs with incompatible denominations (${[...kinds].join(' and ')})`)
    }
  }
}

/** Shared measure-set validation for trusted producers that bypass the
 *  request-shaped custom-query sanitizer. */
export function validateReportMeasureSet(entity: ReportEntity, measures: readonly ReportMeasure[]): void {
  validateFormulaMeasures(entity, measures)
}

/**
 * Custom-report validation refusals are user-actionable (the message names
 * the malformed field, filter, or breakout) and answer 422. A named class
 * keeps them intact through the API error sanitizer; unexpected failures
 * stay anonymous 500s.
 */
export class ReportQueryValidationError extends Error {
  readonly status = 422
  constructor(message: string) {
    super(message)
    this.name = 'ReportQueryValidationError'
  }
}

export function validateCustomQuery(
  raw: unknown,
  entityMap: Record<string, ReportEntity> = REPORT_ENTITY_MAP,
): ReportCustomQuery {
  if (!raw || typeof raw !== 'object') {
    throw new ReportQueryValidationError('Custom query is required')
  }
  const q = raw as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(q, 'sort')) {
    throw new ReportQueryValidationError('Report queries use the ordered "sorts" array')
  }
  const entity = String(q.entity ?? '')
  const entityMeta = Object.prototype.hasOwnProperty.call(entityMap, entity)
    ? entityMap[entity] ?? null
    : null
  if (!entityMeta) {
    throw new ReportQueryValidationError(`Invalid entity: ${entity}`)
  }
  const validColumn = (c: unknown): c is string =>
    typeof c === 'string' && entityColumn(entityMeta, c) !== null

  const mode: 'rows' | 'summarize' = q.mode === 'summarize' ? 'summarize' : 'rows'

  const columns = Array.isArray(q.columns) ? (q.columns as unknown[]).filter(validColumn) : []

  // Summarize: group-by breakouts + aggregate measures.
  const breakouts: ReportBreakout[] = Array.isArray(q.breakouts)
    ? (q.breakouts as unknown[])
        .flatMap((b) => {
          if (!b || typeof b !== 'object') return []
          const o = b as Record<string, unknown>
          if (!validColumn(o.column)) return []
          const bin = REPORT_TEMPORAL_BINS.includes(o.bin as never)
            ? (o.bin as ReportBreakout['bin'])
            : undefined
          return [{ column: o.column, ...(bin ? { bin } : {}) }]
        })
        .slice(0, MAX_BREAKOUTS)
    : []

  const measureFilters = new WeakMap<ReportMeasure, unknown>()
  let measures: ReportMeasure[] = Array.isArray(q.measures)
    ? (q.measures as unknown[])
        .flatMap((m) => {
          if (!m || typeof m !== 'object') return []
          const o = m as Record<string, unknown>
          const fn = String(o.fn ?? '')
          if (!REPORT_AGG_FNS.includes(fn as never)) return []
          if (fn !== 'count' && fn !== 'formula' && !validColumn(o.column)) return []
          const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : undefined
          const key = typeof o.key === 'string' && o.key.trim() ? o.key.trim() : undefined
          const measure: ReportMeasure = {
            fn: fn as ReportMeasure['fn'],
            ...(fn !== 'count' && fn !== 'formula' ? { column: o.column as string } : {}),
            ...(label ? { label } : {}),
            ...(key ? { key } : {}),
            ...(o.hidden === true ? { hidden: true } : {}),
          }
          measureFilters.set(measure, o.filter)
          if (fn === 'formula') {
            if (o.filter != null) throw new ReportQueryValidationError(`Formula measure '${key ?? label ?? 'unnamed formula'}' cannot have a filter — filter its component measures`)
            if (typeof o.format === 'string' && ['ratio', 'percent', 'money', 'number'].includes(o.format)) {
              measure.format = o.format as ReportMeasure['format']
            }
            if (typeof o.expr !== 'undefined') measure.expr = sanitizeFormulaExpr(o.expr, key ?? label ?? 'unnamed formula')
            if (o.scale !== undefined) {
              if (typeof o.scale !== 'number' || !Number.isInteger(o.scale) || o.scale < 0 || o.scale > 12) {
                throw new ReportQueryValidationError(`Formula measure '${key ?? label ?? 'unnamed formula'}' has an invalid scale`)
              }
              measure.scale = o.scale
            }
            if (typeof o.undefinedLabel === 'string' && o.undefinedLabel.trim() && o.undefinedLabel.length <= 120) {
              measure.undefinedLabel = o.undefinedLabel.trim()
            }
            if (o.guards !== undefined) {
              if (!Array.isArray(o.guards) || o.guards.length > MAX_MEASURES) {
                throw new ReportQueryValidationError(`Formula measure '${key ?? label ?? 'unnamed formula'}' has invalid guards`)
              }
              measure.guards = o.guards.map((rawGuard) => {
                if (!rawGuard || typeof rawGuard !== 'object') throw new ReportQueryValidationError(`Formula measure '${key ?? label ?? 'unnamed formula'}' has an invalid guard`)
                const guard = rawGuard as Record<string, unknown>
                if (typeof guard.measure !== 'string' || !guard.measure || (guard.when !== 'zero' && guard.when !== 'null')
                  || typeof guard.label !== 'string' || !guard.label.trim() || guard.label.length > 120) {
                  throw new ReportQueryValidationError(`Formula measure '${key ?? label ?? 'unnamed formula'}' has an invalid guard`)
                }
                return { measure: guard.measure, when: guard.when, label: guard.label.trim() }
              })
            }
          }
          return [measure]
        })
        .slice(0, MAX_MEASURES)
    : []

  if (mode === 'rows' && columns.length === 0) {
    throw new ReportQueryValidationError('Pick at least one column to include')
  }
  // Summarize is always valid: with no measures the query defaults to a count
  // (and with no breakouts that count is a single grand total).
  if (mode === 'summarize' && measures.length === 0) {
    measures = [{ fn: 'count' }]
  }
  if (mode === 'summarize' && breakouts.length === 0 && measures.length > 0 && measures.every((measure) => measure.hidden)) {
    throw new ReportQueryValidationError('Select at least one visible measure')
  }

  // Totals only mean something for sectioned summaries; whitelist the shape.
  const rawTotals = (q as { totals?: unknown }).totals
  const sanitizeDerived = (raw: unknown) => {
    if (!Array.isArray(raw)) return []
    const clean: { label: string; plus: { field: string; value: string }; minus?: { field: string; value: string } }[] = []
    const leg = (v: unknown): { field: string; value: string } | null => {
      if (!v || typeof v !== 'object') return null
      const { field, value } = v as Record<string, unknown>
      if (!validColumn(field) || typeof value !== 'string' || value.length > 128) return null
      return { field: field as string, value }
    }
    for (const entry of raw.slice(0, 4)) {
      if (!entry || typeof entry !== 'object') continue
      const { label } = entry as Record<string, unknown>
      const plus = leg((entry as Record<string, unknown>).plus)
      const minus = (entry as Record<string, unknown>).minus === undefined
        ? undefined
        : leg((entry as Record<string, unknown>).minus) ?? undefined
      if (typeof label !== 'string' || !label.trim() || label.length > 64 || !plus) continue
      clean.push({ label: label.trim(), plus, ...(minus ? { minus } : {}) })
    }
    return clean
  }
  const totals = mode === 'summarize' && rawTotals && typeof rawTotals === 'object' && !Array.isArray(rawTotals)
    ? {
        ...((rawTotals as { sections?: unknown }).sections === true ? { sections: true } : {}),
        ...((rawTotals as { grand?: unknown }).grand === true ? { grand: true } : {}),
        ...(() => {
          const derived = sanitizeDerived((rawTotals as { derived?: unknown }).derived)
          return derived.length ? { derived } : {}
        })(),
      }
    : null

  // Canonical nested filter tree.
  let ruleCount = 0
  function sanitizeGroup(g: unknown, depth: number): ReportRuleGroup {
    if (!g || typeof g !== 'object') throw new ReportQueryValidationError('Invalid filter group')
    if (depth > MAX_DEPTH) throw new ReportQueryValidationError('Filter tree is too deep')
    const o = g as Record<string, unknown>
    if (!Array.isArray(o.rules)) throw new ReportQueryValidationError('Invalid filter group rules')
    const rules: (ReportRule | ReportRuleGroup)[] = []
    for (const r of o.rules) {
      if (!r || typeof r !== 'object') throw new ReportQueryValidationError('Invalid filter rule')
      if (++ruleCount > MAX_RULES) throw new ReportQueryValidationError('Too many filter rules')
      const ro = r as Record<string, unknown>
      if (Array.isArray(ro.rules)) {
        const sub = sanitizeGroup(ro, depth + 1)
        if (sub.rules.length) rules.push(sub)
        continue
      }
      const field = ro.field
      const op = String(ro.op ?? ro.operator ?? '')
      if (!validColumn(field)) throw new ReportQueryValidationError(`Invalid filter field: ${String(field ?? '')}`)
      if (!REPORT_FILTER_OPERATORS.includes(op as never)) {
        throw new ReportQueryValidationError(`Invalid filter operator: ${op}`)
      }
      // An empty-valued rule would compile to nothing and run unfiltered on
      // that leg (or invert the remainder under NOT), while the studio keeps
      // showing a filter that does nothing. Refuse it here by field and
      // operator name so validation and compilation agree: value-less
      // operators (is_null, relative dates, …) take no value, everything else
      // must carry one. between_days_ago/due_within_days default to 30 days
      // when the value is absent, so only an empty string is refused there —
      // Number('') is 0, which would silently mean "today".
      const rawValue = ro.value
      if (op === 'in' || op === 'not_in') {
        if (!Array.isArray(rawValue) || rawValue.length === 0) {
          throw new ReportQueryValidationError(`Filter rule for '${String(field)}' (${op}) requires at least one value`)
        }
        // A mixed-type array would narrow silently downstream (non-matching
        // kinds are dropped from the list), so the report would filter on a
        // subset the studio never showed. Refuse it here by field and
        // operator name: one array, one scalar kind.
        const kinds = new Set(rawValue.map((v) => (typeof v === 'string' ? 'text' : typeof v === 'number' ? 'number' : 'other')))
        if (kinds.size !== 1 || kinds.has('other')) {
          throw new ReportQueryValidationError(`Filter rule for '${String(field)}' (${op}) requires values of one type (all text or all numbers)`)
        }
      } else if (op === 'between_days_ago' || op === 'due_within_days') {
        if (rawValue === '') {
          throw new ReportQueryValidationError(`Filter rule for '${String(field)}' (${op}) requires a number of days`)
        }
        if (rawValue !== null && rawValue !== undefined && !Number.isFinite(Number(rawValue))) {
          throw new ReportQueryValidationError(`Filter rule for '${String(field)}' (${op}) requires a number of days`)
        }
      } else if (op === 'period_preset') {
        if (typeof rawValue !== 'string' || !rawValue) {
          throw new ReportQueryValidationError(`Filter rule for '${String(field)}' (${op}) requires a period preset`)
        }
      } else if (
        op === 'eq' || op === 'neq' || op === 'gte' || op === 'lte' || op === 'contains'
      ) {
        if (rawValue === null || rawValue === undefined || rawValue === '') {
          throw new ReportQueryValidationError(`Filter rule for '${String(field)}' (${op}) requires a value`)
        }
      }
      rules.push({ field, op: op as ReportRule['op'], value: sanitizeValue(ro.value) })
    }
    return {
      combinator: o.combinator === 'or' ? 'or' : 'and',
      ...(o.not === true ? { not: true } : {}),
      rules,
    }
  }
  const filters = q.filters == null ? null : sanitizeGroup(q.filters, 1)
  const filtersFinal = filters && filters.rules.length ? filters : null
  measures = measures.map((measure) => {
    const rawFilter = measureFilters.get(measure)
    if (rawFilter == null) return measure
    const filter = sanitizeGroup(rawFilter, 1)
    if (!filter.rules.length) throw new ReportQueryValidationError(`Measure '${measure.key ?? measure.label ?? measure.fn}' has an empty filter`)
    return { ...measure, filter }
  })
  validateFormulaMeasures(entityMeta, measures)

  const groupBy = validColumn(q.groupBy) ? q.groupBy : null
  const measureKeys = new Set(measures.flatMap((measure) => measure.key ? [measure.key] : []))
  const sanitizeSort = (raw: unknown): { column: string; direction: 'asc' | 'desc' } | null => {
    if (!raw || typeof raw !== 'object') return null
    const s = raw as Record<string, unknown>
    if (typeof s.column !== 'string' || (!validColumn(s.column) && !measureKeys.has(s.column))) return null
    return {
      column: s.column,
      direction: s.direction === 'asc' ? ('asc' as const) : ('desc' as const),
    }
  }
  // Multi-level sort: valid columns only, deduped, capped.
  const seenSortCols = new Set<string>()
  const sorts = Array.isArray(q.sorts)
    ? (q.sorts as unknown[])
        .map(sanitizeSort)
        .filter((s): s is NonNullable<typeof s> => s !== null && !seenSortCols.has(s.column) && !!seenSortCols.add(s.column))
        .slice(0, MAX_SORT_LEVELS)
    : []
  // Column-label overrides: only for columns actually selected, trimmed + capped.
  const columnLabels: Record<string, string> = {}
  if (q.columnLabels && typeof q.columnLabels === 'object' && !Array.isArray(q.columnLabels)) {
    for (const [key, value] of Object.entries(q.columnLabels as Record<string, unknown>)) {
      if (!columns.includes(key)) continue
      if (typeof value !== 'string') continue
      const trimmed = value.trim().slice(0, MAX_LABEL_LEN)
      if (trimmed) columnLabels[key] = trimmed
    }
  }
  const limit = normalizeReportLimit(Number(q.limit))

  return {
    entity,
    mode,
    columns,
    breakouts,
    measures,
    filters: filtersFinal,
    groupBy,
    ...(totals && Object.keys(totals).length ? { totals } : {}),
    ...(sorts.length ? { sorts } : {}),
    ...(Object.keys(columnLabels).length ? { columnLabels } : {}),
    limit,
  }
}

/** Sanitise a page-setup payload: whitelist paper/orientation, clamp margins.
 *  Returns null when absent so the definition falls back to the default. */
export function validateReportLayout(raw: unknown): ReportLayoutConfig | null {
  if (!raw || typeof raw !== 'object') return null
  return resolveReportLayout(raw as Partial<ReportLayoutConfig>)
}

function sanitizeValue(v: unknown): ReportRule['value'] {
  if (v === null || typeof v === 'undefined') return null
  if (typeof v === 'string' || typeof v === 'number') return v
  if (Array.isArray(v)) {
    const strings = v.filter((x): x is string => typeof x === 'string')
    if (strings.length === v.length) return strings
    const numbers = v.filter((x): x is number => typeof x === 'number')
    if (numbers.length === v.length) return numbers
    return strings
  }
  return String(v)
}
