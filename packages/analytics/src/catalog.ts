// What an insight card can query — DERIVED, not authored. The single source of
// truth is the report entity catalog (packages/reports/src/entities.ts), the
// same list the custom report builder and saved views read. This module
// projects each entity into the insights query model: column `kind` becomes a
// semantic type, which decides whether a field can be a dimension (group /
// filter) or a measure (aggregate).
//
// One list, three surfaces. Adding an entity to the report catalog adds a
// source here; there is no second place to forget.
//
// Injection safety is inherited: every identifier the compiler interpolates
// (`from`, `orgColumn`, field `expr`) is a compile-time constant in the report
// catalog. User input only ever names catalog KEYS; values always bind as
// parameters.

import {
  REPORT_ENTITIES,
  defaultColumnsFor,
  type ReportColumnKind,
  type ReportEntity,
  type ReportEntityColumn,
} from '@openbooks/reports'
import { buildSource, type AnalyticsSource, type CatalogField, type CatalogSource } from './semantic'
import type { SemanticType } from './types'

/** Columns a raw (non-aggregated) detail card shows by default. */
const DETAIL_COLUMN_COUNT = 8

/** Report column kind → insights semantic type. `timestamp` narrows to `date`
 *  (the compiler's date_trunc bins cast to date either way); `uuid` stays a
 *  plain category so an id can still be grouped or filtered. */
function semanticTypeFor(kind: ReportColumnKind): SemanticType {
  switch (kind) {
    case 'date':
    case 'timestamp':
      return 'date'
    case 'number':
      return 'number'
    case 'money':
      return 'currency'
    default:
      return 'category'
  }
}

function toField(column: ReportEntityColumn): CatalogField {
  return {
    key: column.key,
    label: column.label,
    expr: column.expr,
    semanticType: semanticTypeFor(column.kind),
    ...(column.kind === 'boolean' ? { valueKind: 'boolean' as const } : {}),
    ...(column.options?.length ? { options: column.options } : {}),
  }
}

export function sourceFromEntity(entity: ReportEntity): CatalogSource {
  return {
    key: entity.key,
    label: entity.label,
    category: entity.category,
    description: entity.description,
    from: entity.from,
    orgColumn: entity.orgColumn,
    fields: entity.columns.map(toField),
    detailColumns: defaultColumnsFor(entity, DETAIL_COLUMN_COUNT),
    ...(entity.defaultSort
      ? { defaultSort: { field: entity.defaultSort.column, dir: entity.defaultSort.direction } }
      : {}),
    ...(entity.requiredPermission ? { requiredPermission: entity.requiredPermission } : {}),
    ...(entity.baseFilter ? { baseFilter: entity.baseFilter } : {}),
  }
}

export const INSIGHT_SOURCES: AnalyticsSource[] = REPORT_ENTITIES.map((entity) =>
  buildSource(sourceFromEntity(entity)),
)

export const INSIGHT_SOURCE_MAP: Record<string, AnalyticsSource> = Object.fromEntries(
  INSIGHT_SOURCES.map((s) => [s.key, s]),
)

export function getSource(key: string): AnalyticsSource | null {
  return INSIGHT_SOURCE_MAP[key] ?? null
}

/** The permission a caller needs to run a query against `sourceKey`, or null
 *  when insights.read alone is enough. The query API gates on this; the studio
 *  hides sources the caller can't run. */
export function sourcePermission(sourceKey: string): string | null {
  return getSource(sourceKey)?.requiredPermission ?? null
}

/** The sources a caller may build on, given a permission predicate. */
export function allowedSources(can: (permission: string) => boolean): AnalyticsSource[] {
  return INSIGHT_SOURCES.filter((s) => !s.requiredPermission || can(s.requiredPermission))
}
