// Runtime validation for an InsightQuery loaded from jsonb / a request body.
// The compiler already fails closed on unknown keys, but validating structure
// first turns malformed-plan bugs into clean 422s instead of opaque throws and
// keeps the persisted shape honest. Pure — safe on client or server.

import { getSource } from './catalog'
import { migrateLegacyQuery } from './legacy'
import { sourceField } from './semantic'
import { FILTER_OPS } from './types'
import type { InsightCompileErrorCode } from './compile'
import type { AggFn, DateBin, FilterOp, InsightQuery } from './types'

export class InsightValidationError extends Error {
  readonly name = 'InsightValidationError'
  /** Set for catalog-referencing failures a user can cause from the studio —
   *  shares the compile-error code vocabulary so the API translates both the
   *  same way. Absent on pure structural corruption (technical detail). */
  readonly code?: InsightCompileErrorCode
  readonly subject?: string

  constructor(message: string, code?: InsightCompileErrorCode, subject?: string) {
    super(message)
    this.code = code
    this.subject = subject
  }
}

const AGG_FNS: AggFn[] = ['sum', 'count', 'avg', 'min', 'max']
const DATE_BINS: DateBin[] = ['day', 'week', 'month', 'quarter', 'year']
const FILTER_OP_SET = new Set<string>(FILTER_OPS)

function fail(msg: string, code?: InsightCompileErrorCode, subject?: string): never {
  throw new InsightValidationError(msg, code, subject)
}

/** Validate structure + that every referenced field/op exists in the catalog.
 *  Throws InsightValidationError with a human message; returns the query on
 *  success (narrowed). */
export function validateInsightQuery(input: unknown): InsightQuery {
  if (!input || typeof input !== 'object') fail('query must be an object')
  // Cards saved against the pre-unification insights catalog still name a few
  // renamed fields (and legacy 'yes'/'active' boolean codes) — rewrite those
  // onto the current catalog before anything is judged unknown.
  const q = migrateLegacyQuery(input as InsightQuery) as unknown as Record<string, unknown>

  if (typeof q.source !== 'string') fail('query.source is required')
  const source = getSource(q.source)
  if (!source) fail(`unknown source "${q.source}"`, 'unknown_source', q.source)

  const measures = Array.isArray(q.measures) ? q.measures : []
  const dimensions = Array.isArray(q.dimensions) ? q.dimensions : []
  const filters = Array.isArray(q.filters) ? q.filters : []
  const sort = Array.isArray(q.sort) ? q.sort : []

  for (const m of measures) {
    if (!m || typeof m !== 'object') fail('each measure must be an object')
    const agg = (m as any).agg
    if (!AGG_FNS.includes(agg)) fail(`invalid aggregation "${agg}"`, 'unknown_aggregation', String(agg))
    if (agg !== 'count') {
      const field = sourceField(source, (m as any).field)
      if (!field) fail(`unknown measure field "${(m as any).field}"`, 'unknown_field', String((m as any).field))
      if (!field.canMeasure) fail(`"${field.key}" is not a numeric measure`, 'not_a_measure', field.key)
    }
  }

  for (const d of dimensions) {
    if (!d || typeof d !== 'object') fail('each dimension must be an object')
    const field = sourceField(source, (d as any).field)
    if (!field) fail(`unknown dimension "${(d as any).field}"`, 'unknown_field', String((d as any).field))
    if (!field.canDimension) fail(`"${field.key}" cannot be a dimension`, 'not_a_dimension', field.key)
    const bin = (d as any).bin
    if (bin != null && !DATE_BINS.includes(bin)) fail(`invalid date bin "${bin}"`, 'unknown_bin', String(bin))
    if (bin != null && !field.canBin) fail(`"${field.key}" cannot be bucketed by date`, 'unknown_bin', field.key)
  }

  for (const f of filters) {
    if (!f || typeof f !== 'object') fail('each filter must be an object')
    const field = sourceField(source, (f as any).field)
    if (!field) fail(`unknown filter field "${(f as any).field}"`, 'unknown_field', String((f as any).field))
    const op = (f as any).op as FilterOp
    if (!FILTER_OP_SET.has(op)) fail(`invalid filter operator "${op}"`, 'unknown_operator', String(op))
  }

  for (const s of sort) {
    if (!s || typeof s !== 'object') fail('each sort entry must be an object')
    if (typeof (s as any).ref !== 'string') fail('sort.ref must be a string')
    const dir = (s as any).dir
    if (dir !== 'asc' && dir !== 'desc') fail('sort.dir must be asc or desc')
  }

  if (q.limit != null && (typeof q.limit !== 'number' || !Number.isFinite(q.limit))) {
    fail('limit must be a number or null')
  }

  return {
    source: q.source,
    measures: measures as InsightQuery['measures'],
    dimensions: dimensions as InsightQuery['dimensions'],
    filters: filters as InsightQuery['filters'],
    sort: sort as InsightQuery['sort'],
    limit: (q.limit as number | null | undefined) ?? null,
  }
}
