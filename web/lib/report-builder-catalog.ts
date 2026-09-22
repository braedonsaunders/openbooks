import type { ReportEntity, ReportEntityColumn } from '@openbooks/reports'

export type ReportColumnGroup = 'record' | 'related' | 'identifiers'

/**
 * One authoritative visibility pass for the report studio. The caller supplies
 * the already-authorized native and custom catalogs; this helper only removes
 * the keys the server explicitly withheld and orders the remainder so grouped
 * search results stay contiguous and predictable.
 */
export function availableReportEntities(
  entities: readonly ReportEntity[],
  hiddenEntityKeys: readonly string[],
): ReportEntity[] {
  const hidden = new Set(hiddenEntityKeys)
  return [...entities]
    .filter((entity) => !hidden.has(entity.key))
    .sort((left, right) =>
      left.category.localeCompare(right.category) || left.label.localeCompare(right.label),
    )
}

/**
 * Classify a field for the builder without creating a second report catalog.
 * Catalog SQL is server-authored, so its table aliases are safe metadata here:
 * a field whose expression reaches beyond the entity's owning alias is a
 * related/joined field. Stable identifiers remain selectable, but live in a
 * quieter group instead of crowding the ordinary business fields.
 */
export function reportColumnGroup(
  entity: ReportEntity,
  column: ReportEntityColumn,
): ReportColumnGroup {
  if (
    column.kind === 'uuid'
    || column.key === 'id'
    || column.key === 'org_id'
    || column.key.endsWith('_id')
  ) {
    return 'identifiers'
  }

  const baseAlias = /^([a-z_][a-z0-9_]*)\./i.exec(entity.orgColumn)?.[1]
  if (!baseAlias) return 'record'
  const aliases = [...column.expr.matchAll(/\b([a-z_][a-z0-9_]*)\./gi)].map((match) => match[1])
  return aliases.some((alias) => alias !== baseAlias) ? 'related' : 'record'
}
