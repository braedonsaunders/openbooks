// Semantic layer — the source/field model the whole engine trusts. Each SOURCE
// carries UI metadata (labels, semantic types — drives the card studio) and SQL
// metadata (a server-authored FROM clause + per-field SQL expressions — drives
// the compiler). Every field a caller references is a KEY looked up here; the
// compiler re-derives the physical expression through the same lookup, so
// neither layer ever trusts a caller-supplied physical column name.
//
// Pure + runtime-free: safe to import from client bundles.

import type { ReportRuleGroup } from '@openbooks/reports'
import type { AggFn, FilterOp, SemanticType } from './types'

/** Authored field definition (catalog input). */
export type CatalogField = {
  /** Public key used in stored queries (snake_case). */
  key: string
  /** English display label. The web layer translates by key
   *  (insights.catalog.fields.<source>.<field>) and falls back to this. */
  label: string
  /**
   * Table-qualified SQL expression used VERBATIM as the field reference
   * (e.g. `je.posting_date`, `coalesce(jl.memo, je.memo)`). Server-authored
   * only — NEVER derived from user input.
   */
  expr: string
  semanticType: SemanticType
  /** Overrides the default role. `date`/`category` → dimension-only;
   *  `number`/`currency` → measurable + dimensionable. Set explicitly to force
   *  a numeric id to be a dimension, etc. */
  role?: FieldRole
  /**
   * Marks a field whose VALUES are a fixed vocabulary the renderer localizes.
   * `boolean` is the only one: the expr yields a real Postgres boolean and the
   * renderer prints it as the locale's yes/no, so stored filters (which bind
   * the literals 'true'/'false') stay locale-proof.
   */
  valueKind?: ValueKind
  /**
   * The known value set for a fixed-vocabulary field (enum or boolean) — the
   * studio offers these as a picker instead of a free-text filter box. Values
   * are the raw stored codes; the UI localizes them for display.
   */
  options?: readonly string[]
}

/** Fixed value vocabularies a field can emit (see CatalogField.valueKind). */
export type ValueKind = 'boolean'

export type FieldRole = 'dimension' | 'measure' | 'both'

export type AnalyticsField = CatalogField & {
  role: FieldRole
  canDimension: boolean
  canMeasure: boolean
  /** Date fields can be calendar-bucketed. */
  canBin: boolean
}

/** A query source — an authored FROM subquery with typed fields. */
export type CatalogSource = {
  /** Source key stored in queries (validated against the catalog). */
  key: string
  label: string
  category: string
  /** One line under the source name in the picker. */
  description: string
  /**
   * Raw FROM clause (without the FROM keyword) — base table plus label joins.
   * Server-authored constant.
   */
  from: string
  /** Qualified org-scoping column (e.g. `jl.org_id`). The compiler ALWAYS ANDs
   *  `orgColumn = $org` into the WHERE — no query escapes the org. */
  orgColumn: string
  fields: CatalogField[]
  /** Fields (by key) returned by a raw detail query, in order. */
  detailColumns: string[]
  defaultSort?: { field: string; dir: 'asc' | 'desc' }
  /** Permission (beyond insights.read) required to build or run a query
   *  against this source — sensitive data like payroll wages. Enforced by the
   *  query API and filtered out of the studio's source picker. */
  requiredPermission?: string
  /** Authoritative Company Settings feature, inherited from the report entity. */
  featureKey?: string
  /** Implicit predicate ALWAYS AND-ed into every query against this source.
   *  Authored in the catalog, never from user input. */
  baseFilter?: ReportRuleGroup
}

export type AnalyticsSource = Omit<CatalogSource, 'fields'> & {
  fields: AnalyticsField[]
}

function defaultRole(t: SemanticType): FieldRole {
  return t === 'number' || t === 'currency' ? 'both' : 'dimension'
}

export function decorateField(f: CatalogField): AnalyticsField {
  const role = f.role ?? defaultRole(f.semanticType)
  return {
    ...f,
    role,
    canDimension: role === 'dimension' || role === 'both',
    canMeasure: role === 'measure' || role === 'both',
    canBin: f.semanticType === 'date',
  }
}

export function buildSource(def: CatalogSource): AnalyticsSource {
  return { ...def, fields: def.fields.map(decorateField) }
}

export function sourceField(source: AnalyticsSource, key: string): AnalyticsField | null {
  return source.fields.find((f) => f.key === key) ?? null
}

/** The full SQL reference for a whitelisted field key — the single place every
 *  consumer builds a field reference. Returns null for unknown keys. */
export function fieldRef(source: AnalyticsSource, key: string): string | null {
  return sourceField(source, key)?.expr ?? null
}

// --- aggregations ------------------------------------------------------------

export type AggMeta = { key: AggFn; label: string; needsNumber: boolean }

export const AGG_FUNCTIONS: AggMeta[] = [
  { key: 'sum', label: 'Sum', needsNumber: true },
  { key: 'avg', label: 'Average', needsNumber: true },
  { key: 'count', label: 'Count', needsNumber: false },
  { key: 'min', label: 'Minimum', needsNumber: true },
  { key: 'max', label: 'Maximum', needsNumber: true },
]

// --- operators ---------------------------------------------------------------

export type OperatorMeta = {
  key: FilterOp
  label: string
  /** Value input the studio renders next to the operator. */
  needsValue: 'none' | 'one' | 'list' | 'number'
  /** Restrict to specific semantic types (undefined = all). */
  types?: SemanticType[]
}

export const FILTER_OPERATORS: OperatorMeta[] = [
  { key: 'eq', label: 'equals', needsValue: 'one' },
  { key: 'neq', label: 'not equals', needsValue: 'one' },
  { key: 'in', label: 'is any of', needsValue: 'list' },
  { key: 'not_in', label: 'is none of', needsValue: 'list' },
  { key: 'gt', label: 'greater than', needsValue: 'one', types: ['date', 'number', 'currency'] },
  { key: 'gte', label: 'on or after / ≥', needsValue: 'one', types: ['date', 'number', 'currency'] },
  { key: 'lt', label: 'less than', needsValue: 'one', types: ['date', 'number', 'currency'] },
  { key: 'lte', label: 'on or before / ≤', needsValue: 'one', types: ['date', 'number', 'currency'] },
  { key: 'contains', label: 'contains', needsValue: 'one', types: ['category'] },
  { key: 'is_null', label: 'is empty', needsValue: 'none' },
  { key: 'is_not_null', label: 'is set', needsValue: 'none' },
  { key: 'last_n_days', label: 'within last N days', needsValue: 'number', types: ['date'] },
  { key: 'this_month', label: 'is this month', needsValue: 'none', types: ['date'] },
  { key: 'this_quarter', label: 'is this quarter', needsValue: 'none', types: ['date'] },
  { key: 'this_year', label: 'is this year', needsValue: 'none', types: ['date'] },
  { key: 'ytd', label: 'year to date', needsValue: 'none', types: ['date'] },
]

export function operatorsForType(t: SemanticType): OperatorMeta[] {
  return FILTER_OPERATORS.filter((o) => !o.types || o.types.includes(t))
}

export const FILTER_OPERATOR_MAP: Record<FilterOp, OperatorMeta> = Object.fromEntries(
  FILTER_OPERATORS.map((o) => [o.key, o]),
) as Record<FilterOp, OperatorMeta>

export function aggLabel(agg: AggFn): string {
  return AGG_FUNCTIONS.find((a) => a.key === agg)?.label ?? agg
}
