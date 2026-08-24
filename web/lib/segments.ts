import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'

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
export async function segmentRegistry(orgId?: string): Promise<SegmentDefinitionOption[]> {
  const orgFilter = orgId ? sql`and sd.org_id = ${orgId}` : sql``
  const result = (await db.execute(sql`
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
     where sd.is_active ${orgFilter}
     group by sd.id
     order by sd.sort_order, sd.name
  `))
  return result.rows.map((row: any) => ({
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

export async function customSegmentOptions(orgId?: string) {
  return (await segmentRegistry(orgId)).filter((segment) => segment.sourceKind === 'custom')
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
