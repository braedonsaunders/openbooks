// Compatibility for cards saved against the hand-authored insights catalog
// that preceded the shared report-entity catalog.
//
// Two things drifted when the catalogs merged:
//   1. a few field KEYS were spelled differently on each side
//      (insights `party` / reports `party_name`), and
//   2. boolean fields used to be wrapped in a `case when … then 'yes'` expr, so
//      stored filters hold the strings 'yes' / 'active' — which are not valid
//      input for the real boolean column they now resolve to ('active' fails
//      the Postgres boolean parse outright).
//
// Every entry point normalizes through validateInsightQuery, so migrating here
// keeps existing cards rendering. The studio re-saves the migrated plan on the
// next edit; this map is only ever read, never written to.

import { getSource } from './catalog'
import { sourceField, type AnalyticsSource } from './semantic'
import type { InsightQuery, QueryFilter } from './types'

/** old field key → current catalog key, per source. */
const FIELD_ALIASES: Record<string, Record<string, string>> = {
  ledger_lines: { party: 'party_name', entry_origin: 'origin' },
  documents: { party: 'party_name', document_count: 'id' },
  accounts: { account_count: 'id' },
}

/** Legacy fixed-vocabulary codes → the boolean literals Postgres accepts. */
const BOOLEAN_VALUES: Record<string, string> = {
  yes: 'true',
  no: 'false',
  active: 'true',
  inactive: 'false',
  true: 'true',
  false: 'false',
}

export function migrateFieldKey(sourceKey: string, fieldKey: string): string {
  return FIELD_ALIASES[sourceKey]?.[fieldKey] ?? fieldKey
}

type FilterValue = QueryFilter['value']

function migrateValue(source: AnalyticsSource, fieldKey: string, value: FilterValue): FilterValue {
  if (sourceField(source, fieldKey)?.valueKind !== 'boolean') return value
  const coerce = <T,>(v: T): T | string =>
    typeof v === 'string' ? (BOOLEAN_VALUES[v.toLowerCase()] ?? v) : v
  return Array.isArray(value) ? (value.map(coerce) as (string | number)[]) : coerce(value)
}

/**
 * Rewrite a stored plan's field references (and fixed-vocabulary filter values)
 * onto the current catalog. Unknown keys pass through untouched so validation
 * still reports them.
 */
export function migrateLegacyQuery(query: InsightQuery): InsightQuery {
  const sourceKey = query.source
  const source = getSource(sourceKey)
  if (!source) return query
  const key = (k: string) => migrateFieldKey(sourceKey, k)

  return {
    ...query,
    ...(query.measures ? { measures: query.measures.map((m) => (m.field ? { ...m, field: key(m.field) } : m)) } : {}),
    ...(query.dimensions ? { dimensions: query.dimensions.map((d) => ({ ...d, field: key(d.field) })) } : {}),
    ...(query.filters
      ? {
          filters: query.filters.map((f) => {
            const field = key(f.field)
            return 'value' in f ? { ...f, field, value: migrateValue(source, field, f.value) } : { ...f, field }
          }),
        }
      : {}),
  }
}
