// Semantic layer — the entity/column model the whole engine trusts. Ported from
// beaconhs (@beaconhs/reports/entities + @beaconhs/analytics/semantic), with the
// runtime schema discovery stripped: openbooks uses a hand-authored catalog
// (./catalog.ts) instead.
//
// Each entity carries both the UI metadata (labels, kinds, semantic types —
// drives the card studio) and the SQL metadata (physical table or authored FROM
// subquery, whitelisted column identifiers — drives the compiler). Every BHQL
// identifier is checked against this whitelist; the compiler re-derives
// identifiers through the same whitelist, so neither layer ever trusts a
// caller-supplied physical column name.
//
// Pure + runtime-free: safe to import from client bundles.

import type { FilterOperator, RuleGroup } from './types'

export type ColumnKind = 'text' | 'date' | 'timestamp' | 'enum' | 'uuid' | 'number'

/** How to interpret a column — drives auto-viz, binning and formatting. */
export type SemanticType =
  | 'dimension' // generic groupable categorical
  | 'category' // enum-like categorical, often with known options
  | 'entity-name' // a human label (party/account name) — good axis label
  | 'measure' // additive numeric — default sum/avg target
  | 'temporal' // date/timestamp — drives time bucketing
  | 'pk' // primary key
  | 'fk' // foreign key to another entity
  | 'uuid' // opaque id, not a useful dimension by default
  | 'currency' // numeric money — measure + currency formatting
  | 'percentage' // numeric 0..100 — measure + % formatting
  | 'lat'
  | 'lng'

/** Authored column definition (catalog input). Sparse on purpose: gaps are
 *  filled by `deriveSemanticType` + `decorateColumn`. */
export type CatalogColumnDef = {
  /** Public key used in stored query plans (snake_case). */
  key: string
  label: string
  kind: ColumnKind
  /** Physical column name. Defaults to `key` when omitted. */
  sql?: string
  /**
   * Raw, already-table-qualified SQL expression used VERBATIM as the column
   * reference instead of `"table"."col"`. Server-authored only (never from
   * user input). When set, takes precedence over `sql`/`key` everywhere a
   * physical reference is built.
   */
  expr?: string
  semanticType?: SemanticType
  enumOptions?: { value: string; label: string }[]
}

export type AnalyticsColumn = CatalogColumnDef & {
  semanticType: SemanticType
  /** An array / jsonb-array column the studio can offer to UNNEST. */
  arrayUnnest?: 'array' | 'jsonb'
  /** Derived eligibility (computed once by `buildEntity`). */
  canDimension: boolean
  canMeasure: boolean
  canBinTemporal: boolean
  canBinNumeric: boolean
}

/** A foreign-key relationship — lets the studio/engine follow a FK to a field
 *  on a related entity ("Documents → Party → Name") without a view. Targets are
 *  always catalog entities, so a join can never reach an unlisted table. */
export type AnalyticsRelation = {
  /** Local foreign-key column key pointing at another entity. */
  via: string
  /** Target entity key. */
  target: string
  /** Target column the FK references (usually 'id'). */
  foreignColumn: string
  /** Human label for the relationship. */
  label: string
}

export type AnalyticsEntity = {
  /** Entity key (validated against the catalog). */
  key: string
  label: string
  category: string
  /** A line of helpful text shown under the entity name in the picker. */
  description: string
  /** Alias every column reference is qualified with (`"table"."col"`). */
  table: string
  /**
   * Authored SELECT statement (no trailing semicolon) this entity reads from.
   * When set, the compiler emits `FROM (<from>) "<table>"` — a view-like source
   * with joins/derived columns baked in. When unset, `FROM "<table>"`.
   * Server-authored only, never from user input.
   */
  from?: string
  columns: AnalyticsColumn[]
  /** Featured top-level entity (vs a supporting sub-table). */
  primary?: boolean
  /** Foreign-key relationships to other entities. */
  relations?: AnalyticsRelation[]
  /** Implicit predicate ALWAYS AND-ed into every query against this entity. */
  baseFilter?: RuleGroup
}

// --- helpers -----------------------------------------------------------------

export function entityColumn(entity: AnalyticsEntity, key: string): AnalyticsColumn | null {
  return entity.columns.find((c) => c.key === key) ?? null
}

/** Physical (quoted-safe) column identifier for a whitelisted column key. */
export function entityColumnSql(entity: AnalyticsEntity, key: string): string | null {
  const col = entityColumn(entity, key)
  return col ? (col.sql ?? col.key) : null
}

/**
 * The full SQL reference for a whitelisted column — either its server-authored
 * `expr` (used verbatim) or the default `"table"."col"`. The single place every
 * consumer must build a column reference, so the injection guarantee holds:
 * `expr` is only ever set by trusted catalog code, and physical identifiers
 * still come from the whitelist.
 */
export function columnRef(entity: AnalyticsEntity, key: string): string | null {
  const col = entityColumn(entity, key)
  if (!col) return null
  if (col.expr) return col.expr
  return `"${entity.table}"."${col.sql ?? col.key}"`
}

/** The FROM clause for an entity: its authored subquery aliased to the entity
 *  table name, or the bare physical table. Both sides are catalog-authored. */
export function entityFromSql(entity: AnalyticsEntity): string {
  return entity.from ? `(${entity.from}) "${entity.table}"` : `"${entity.table}"`
}

export function analyticsColumn(entity: AnalyticsEntity, key: string): AnalyticsColumn | null {
  return entityColumn(entity, key)
}

// --- semantic derivation -------------------------------------------------------

/** Infer a sensible semantic type from a column's kind + name when the catalog
 *  doesn't specify one. */
export function deriveSemanticType(col: CatalogColumnDef): SemanticType {
  switch (col.kind) {
    case 'uuid':
      if (col.key === 'id') return 'pk'
      if (col.key.endsWith('_id')) return 'fk'
      return 'uuid'
    case 'date':
    case 'timestamp':
      return 'temporal'
    case 'number':
      return 'measure'
    case 'enum':
      return 'category'
    case 'text':
      return /(^|_)(name|title|party|department|project)($|_)/.test(col.key)
        ? 'entity-name'
        : 'dimension'
    default:
      return 'dimension'
  }
}

export function decorateColumn(col: CatalogColumnDef): AnalyticsColumn {
  const semanticType = col.semanticType ?? deriveSemanticType(col)
  const isNumber = col.kind === 'number'
  const isTemporal = col.kind === 'date' || col.kind === 'timestamp'
  return {
    ...col,
    semanticType,
    // A primary key is unique → useless to group by; everything else is fair game.
    canDimension: semanticType !== 'pk',
    // count/count_distinct work on anything, but sum/avg need a number.
    canMeasure: isNumber,
    canBinTemporal: isTemporal,
    canBinNumeric: isNumber && semanticType !== 'percentage',
  }
}

/** Authored-entity input: like AnalyticsEntity but with raw column defs. */
export type CatalogEntityDef = Omit<AnalyticsEntity, 'columns'> & {
  columns: CatalogColumnDef[]
}

export function buildEntity(def: CatalogEntityDef): AnalyticsEntity {
  return { ...def, columns: def.columns.map(decorateColumn) }
}

// --- operators -----------------------------------------------------------------

export type OperatorMeta = {
  key: FilterOperator
  label: string
  /** Whether this op needs a value field next to it. */
  needsValue: 'none' | 'one' | 'list'
  /** Restrict to specific column kinds (undefined = applies to all). */
  applicableKinds?: ColumnKind[]
}

export const FILTER_OPERATORS: OperatorMeta[] = [
  { key: 'eq', label: 'equals', needsValue: 'one' },
  { key: 'neq', label: 'not equals', needsValue: 'one' },
  { key: 'in', label: 'is any of', needsValue: 'list' },
  { key: 'not_in', label: 'is none of', needsValue: 'list' },
  {
    key: 'gte',
    label: 'on or after / ≥',
    needsValue: 'one',
    applicableKinds: ['date', 'timestamp', 'number'],
  },
  {
    key: 'lte',
    label: 'on or before / ≤',
    needsValue: 'one',
    applicableKinds: ['date', 'timestamp', 'number'],
  },
  { key: 'is_null', label: 'is empty', needsValue: 'none' },
  { key: 'is_not_null', label: 'is set', needsValue: 'none' },
  { key: 'is_true', label: 'is yes', needsValue: 'none', applicableKinds: ['enum'] },
  { key: 'is_false', label: 'is no', needsValue: 'none', applicableKinds: ['enum'] },
  { key: 'contains', label: 'contains', needsValue: 'one', applicableKinds: ['text'] },
  {
    key: 'between_days_ago',
    label: 'within last N days',
    needsValue: 'one',
    applicableKinds: ['date', 'timestamp'],
  },
  {
    key: 'due_within_days',
    label: 'due within next N days',
    needsValue: 'one',
    applicableKinds: ['date', 'timestamp'],
  },
  { key: 'since_today', label: 'is today', needsValue: 'none', applicableKinds: ['date', 'timestamp'] },
  { key: 'this_week', label: 'is this week', needsValue: 'none', applicableKinds: ['date', 'timestamp'] },
  { key: 'this_month', label: 'is this month', needsValue: 'none', applicableKinds: ['date', 'timestamp'] },
  { key: 'this_year', label: 'is this year', needsValue: 'none', applicableKinds: ['date', 'timestamp'] },
  {
    key: 'before_now',
    label: 'is in the past (overdue)',
    needsValue: 'none',
    applicableKinds: ['date', 'timestamp'],
  },
]

export function operatorsForKind(kind: ColumnKind): OperatorMeta[] {
  return FILTER_OPERATORS.filter((o) => !o.applicableKinds || o.applicableKinds.includes(kind))
}
