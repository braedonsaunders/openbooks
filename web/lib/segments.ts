import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { subsidiaryVisibleFilter } from '@openbooks/engine/src/organization/subsidiary-scope.ts'
import { loadSubsidiaryContext, restrictionAdmits, uuidArray } from '@openbooks/engine/src/organization/subsidiaries.ts'

export type SegmentValueOption = {
  id: string
  code: string | null
  name: string
  parentId: string | null
  subsidiaryId: string | null
  subsidiaryIncludeChildren: boolean
}

export type SegmentDefinitionOption = {
  id: string
  key: string
  name: string
  pluralName: string
  sourceKind: 'builtin' | 'custom'
  storageColumn: string | null
  isHierarchical: boolean
  showOnHeader: boolean
  showOnLines: boolean
  showInReports: boolean
  allowAccountRequirement: boolean
  sortOrder: number
  values: SegmentValueOption[]
}

/**
 * Resolve the active tenant registry. Built-in values remain in their domain
 * tables; custom values are loaded from segment_values. This is the one shape
 * used by editors, account rules, and report controls.
 */
interface SegmentRegistryRow extends Record<string, unknown> {
  id: string
  key: string
  name: string
  plural_name: string
  source_kind: 'builtin' | 'custom'
  storage_column: string | null
  is_hierarchical: boolean
  show_on_header: boolean
  show_on_lines: boolean
  show_in_reports: boolean
  allow_account_requirement: boolean
  sort_order: number
  values: SegmentValueOption[]
}

export async function segmentRegistry(
  orgId?: string,
  allowedSubsidiaryIds?: ReadonlySet<string> | readonly string[] | null,
): Promise<SegmentDefinitionOption[]> {
  const orgFilter = orgId ? sql`and sd.org_id = ${orgId}` : sql``
  const subsidiaryScope = allowedSubsidiaryIds === undefined
    ? sql``
    : subsidiaryVisibleFilter(
        sql`sv.subsidiary_id`,
        allowedSubsidiaryIds === null ? null : new Set(allowedSubsidiaryIds),
        { orgWideNull: true },
      )
  const result = (await db.execute<SegmentRegistryRow>(sql`
    select sd.id, sd.key, sd.name, sd.plural_name, sd.source_kind,
           sd.storage_column, sd.is_hierarchical, sd.show_on_header,
           sd.show_on_lines, sd.show_in_reports,
           sd.allow_account_requirement, sd.sort_order,
           coalesce(jsonb_agg(jsonb_build_object(
             'id', sv.id,
             'code', sv.code,
             'name', sv.name,
             'parentId', sv.parent_id,
             'subsidiaryId', sv.subsidiary_id,
             'subsidiaryIncludeChildren', sv.subsidiary_include_children
           ) order by sv.name) filter (where sv.id is not null), '[]'::jsonb) as values
      from segment_definitions sd
      left join segment_values sv on sv.segment_id = sd.id
       and sv.org_id = sd.org_id and sv.is_active
       ${subsidiaryScope}
     where sd.is_active ${orgFilter}
     group by sd.id
     order by sd.sort_order, sd.name
  `))
  return result.rows.map((row) => ({
    id: row.id,
    key: row.key,
    name: row.name,
    pluralName: row.plural_name,
    sourceKind: row.source_kind,
    storageColumn: row.storage_column,
    isHierarchical: row.is_hierarchical,
    showOnHeader: row.show_on_header,
    showOnLines: row.show_on_lines,
    showInReports: row.show_in_reports,
    allowAccountRequirement: row.allow_account_requirement,
    sortOrder: Number(row.sort_order),
    values: row.values ?? [],
  }))
}

export async function customSegmentOptions(
  orgId?: string,
  allowedSubsidiaryIds?: ReadonlySet<string> | readonly string[] | null,
) {
  return (await segmentRegistry(orgId, allowedSubsidiaryIds)).filter((segment) => segment.sourceKind === 'custom')
}

/** Keep only active custom values belonging to the supplied tenant registry. */
export function sanitizeExtraDims(
  value: unknown,
  registry: SegmentDefinitionOption[],
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const source = value as Record<string, unknown>
  const clean: Record<string, string> = {}
  for (const segment of registry) {
    if (segment.sourceKind !== 'custom') continue
    const selected = source[segment.key]
    if (typeof selected === 'string' && segment.values.some((option) => option.id === selected)) {
      clean[segment.key] = selected
    }
  }
  return clean
}

export function validateExtraDims(
  value: unknown,
  registry: SegmentDefinitionOption[],
): { ok: true; cleaned: Record<string, string> } | { ok: false; error: string } {
  if (value == null) return { ok: true, cleaned: {} }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'Custom segment assignments must be an object' }
  }
  const source = value as Record<string, unknown>
  const custom = new Map(registry.filter((s) => s.sourceKind === 'custom').map((s) => [s.key, s]))
  for (const [key, selected] of Object.entries(source)) {
    const segment = custom.get(key)
    if (!segment) return { ok: false, error: `Unknown or inactive segment: ${key}` }
    if (selected !== null && selected !== '' &&
        (typeof selected !== 'string' || !segment.values.some((option) => option.id === selected))) {
      return { ok: false, error: `Invalid value for ${segment.name}` }
    }
  }
  return { ok: true, cleaned: sanitizeExtraDims(source, registry) }
}

/** Refuse segment values whose legal-entity restriction excludes a posting subsidiary. */
export async function extraDimsSubsidiaryError(
  orgId: string,
  value: Record<string, string>,
  subsidiaryId: string,
  registry: SegmentDefinitionOption[],
  executor: Pick<typeof db, 'execute'> = db,
): Promise<string | null> {
  const segments = new Map(registry.filter((segment) => segment.sourceKind === 'custom').map((segment) => [segment.key, segment]))
  const selected = Object.entries(value).flatMap(([key, id]) => {
    const segment = segments.get(key)
    return segment && id ? [{ key, id, segment }] : []
  })
  if (selected.length === 0) return null
  if (selected.some((entry) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.id))) {
    return 'invalid custom segment assignment'
  }

  const context = await loadSubsidiaryContext(executor, orgId)
  const target = context.byId.get(subsidiaryId)
  if (!target) return 'invalid subsidiary for custom segment assignments'
  const ids = [...new Set(selected.map((entry) => entry.id))]
  const values = (await executor.execute<{
    id: string
    name: string
    segment_id: string
    subsidiary_id: string | null
    subsidiary_include_children: boolean
    is_active: boolean
  }>(sql`
    select id, name, segment_id, subsidiary_id, subsidiary_include_children, is_active
      from segment_values
     where org_id = ${orgId} and id = any(${uuidArray(ids)}::uuid[])
     for share
  `)).rows
  const byId = new Map(values.map((row) => [row.id, row]))
  for (const assignment of selected) {
    const row = byId.get(assignment.id)
    if (!row?.is_active) return `inactive value for custom segment ${assignment.segment.name}`
    if (row.subsidiary_id && !restrictionAdmits(context, row.subsidiary_id, row.subsidiary_include_children, subsidiaryId)) {
      return `custom segment value "${row.name}" is restricted to another subsidiary`
    }
  }
  return null
}
