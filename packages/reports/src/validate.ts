// Server-side sanitiser for untrusted customQuery payloads (ported from the
// beaconhs studio validate.ts). Client JSON is untrusted: entity/columns/
// operators must resolve through the catalog, the filter tree is depth/size-
// capped, and aggregation specs are normalised. Shared by the definitions
// CRUD routes and the run/preview route.

import { REPORT_ENTITY_MAP, entityColumn, type ReportEntity } from './entities'
import {
  REPORT_AGG_FNS,
  REPORT_FILTER_OPERATORS,
  REPORT_TEMPORAL_BINS,
  resolveReportLayout,
  type ReportBreakout,
  type ReportCustomQuery,
  type ReportLayoutConfig,
  type ReportMeasure,
  type ReportRule,
  type ReportRuleGroup,
} from './types'

const MAX_DEPTH = 5
const MAX_RULES = 60
const MAX_BREAKOUTS = 6
const MAX_MEASURES = 8
const MAX_SORT_LEVELS = 3
const MAX_LABEL_LEN = 80

export function validateCustomQuery(
  raw: unknown,
  entityMap: Record<string, ReportEntity> = REPORT_ENTITY_MAP,
): ReportCustomQuery {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Custom query is required')
  }
  const q = raw as Record<string, unknown>
  const entity = String(q.entity ?? '')
  const entityMeta = entityMap[entity] ?? null
  if (!entityMeta) {
    throw new Error(`Invalid entity: ${entity}`)
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

  let measures: ReportMeasure[] = Array.isArray(q.measures)
    ? (q.measures as unknown[])
        .flatMap((m) => {
          if (!m || typeof m !== 'object') return []
          const o = m as Record<string, unknown>
          const fn = String(o.fn ?? '')
          if (!REPORT_AGG_FNS.includes(fn as never)) return []
          if (fn !== 'count' && !validColumn(o.column)) return []
          const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : undefined
          return [
            {
              fn: fn as ReportMeasure['fn'],
              ...(fn === 'count' ? {} : { column: o.column as string }),
              ...(label ? { label } : {}),
            },
          ]
        })
        .slice(0, MAX_MEASURES)
    : []

  if (mode === 'rows' && columns.length === 0) {
    throw new Error('Pick at least one column to include')
  }
  // Summarize is always valid: with no measures the query defaults to a count
  // (and with no breakouts that count is a single grand total).
  if (mode === 'summarize' && measures.length === 0) {
    measures = [{ fn: 'count' }]
  }

  // Canonical nested filter tree.
  let ruleCount = 0
  function sanitizeGroup(g: unknown, depth: number): ReportRuleGroup {
    if (!g || typeof g !== 'object') throw new Error('Invalid filter group')
    if (depth > MAX_DEPTH) throw new Error('Filter tree is too deep')
    const o = g as Record<string, unknown>
    if (!Array.isArray(o.rules)) throw new Error('Invalid filter group rules')
    const rules: (ReportRule | ReportRuleGroup)[] = []
    for (const r of o.rules) {
      if (!r || typeof r !== 'object') throw new Error('Invalid filter rule')
      if (++ruleCount > MAX_RULES) throw new Error('Too many filter rules')
      const ro = r as Record<string, unknown>
      if (Array.isArray(ro.rules)) {
        const sub = sanitizeGroup(ro, depth + 1)
        if (sub.rules.length) rules.push(sub)
        continue
      }
      const field = ro.field
      const op = String(ro.op ?? ro.operator ?? '')
      if (!validColumn(field)) throw new Error(`Invalid filter field: ${String(field ?? '')}`)
      if (!REPORT_FILTER_OPERATORS.includes(op as never)) {
        throw new Error(`Invalid filter operator: ${op}`)
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

  const groupBy = validColumn(q.groupBy) ? q.groupBy : null
  const sanitizeSort = (raw: unknown): { column: string; direction: 'asc' | 'desc' } | null => {
    if (!raw || typeof raw !== 'object') return null
    const s = raw as Record<string, unknown>
    if (!validColumn(s.column)) return null
    return {
      column: s.column,
      direction: s.direction === 'asc' ? ('asc' as const) : ('desc' as const),
    }
  }
  const sort = sanitizeSort(q.sort)
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
  const limit = Number.isFinite(Number(q.limit))
    ? Math.min(Math.max(Number(q.limit), 1), 10_000)
    : 1000

  return {
    entity,
    mode,
    columns,
    breakouts,
    measures,
    filters: filtersFinal,
    groupBy,
    sort,
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
