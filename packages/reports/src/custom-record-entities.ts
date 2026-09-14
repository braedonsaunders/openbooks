import type { ReportEntity, ReportEntityColumn, ReportColumnKind } from './entities'

export interface CustomRecordDefinition {
  id: string
  key: string
  name: string
  description: string | null
  fields: unknown
}

/** Metadata is tenant-authored: SQL literals must be quoted, never interpolated raw. */
export const queryLiteral = (value: string): string => "'" + value.replaceAll("'", "''") + "'"
export const queryIdentifier = (value: string): string => '"' + value.replaceAll('"', '""') + '"'

export function customFieldColumn(field: { id: string; type: string; label?: string; validation?: { options?: { value: string }[] }; config?: { format?: string } }, source = 'r.data', prefix = 'field_'): ReportEntityColumn | null {
  const kinds: Record<string, ReportColumnKind> = {
    text: 'text', long_text: 'text', email: 'text', url: 'text', phone: 'text',
    number: 'number', integer: 'number', decimal: 'number', currency: 'number', amount: 'number', rating: 'number', formula: 'number', money: 'number', percent: 'number', percentage: 'number',
    date: 'date', datetime: 'timestamp', checkbox: 'boolean', boolean: 'boolean',
    select: 'enum', radio: 'enum', party: 'uuid', gl_account: 'uuid',
  }
  const kind = field.type === 'formula' && field.config?.format === 'text' ? 'text' : kinds[field.type]
  if (!kind) return null
  const text = `nullif(${source} ->> ${queryLiteral(field.id)}, '')`
  const cast = ({ number: 'numeric', date: 'date', timestamp: 'timestamptz', boolean: 'boolean', uuid: 'uuid' } as Record<string,string>)[kind]
  return { key: prefix + field.id, label: field.label || field.id, kind,
    expr: cast ? `(${text})::${cast}` : text,
    ...(kind === 'enum' ? { options: (field.validation?.options ?? []).map(o => o.value) } : {}),
  }
}

/** One entity per published type, plus one explicitly row-grained entity per sublist. */
export function customRecordEntities(definition: CustomRecordDefinition): ReportEntity[] {
  const sections = Array.isArray(definition.fields) ? definition.fields : []
  const base: ReportEntityColumn[] = [
    { key: 'id', label: 'Record ID', kind: 'uuid', expr: 'r.id' },
    { key: 'type_id', label: 'Type ID', kind: 'uuid', expr: 'r.type_id' },
    { key: 'record_number', label: 'Record number', kind: 'text', expr: 'r.record_number' },
    { key: 'status', label: 'Status', kind: 'enum', expr: 'r.status', options: ['draft', 'active', 'inactive'] },
    { key: 'created_at', label: 'Created', kind: 'timestamp', expr: 'r.created_at' },
    { key: 'updated_at', label: 'Updated', kind: 'timestamp', expr: 'r.updated_at' },
  ]
  const headers = sections.filter(s => !s.repeating).flatMap(s => Array.isArray(s.fields) ? s.fields : [])
  const fields = headers.flatMap(f => { const c = customFieldColumn(f); return c ? [c] : [] })
  const entity: ReportEntity = {
    key: `custom:${definition.key}`, label: definition.name, category: 'custom_records',
    description: definition.description || 'Organization-defined records',
    from: 'custom_records r', orgColumn: 'r.org_id', subsidiaryScope: null,
    columns: [...base, ...fields], requiredPermission: 'records.read', defaultPeriodField: null,
    defaultSort: { column: 'record_number', direction: 'asc' },
    baseFilter: { combinator: 'and', rules: [{ field: 'type_id', op: 'eq', value: definition.id }] },
  }
  return [entity, ...sections.filter(s => s.repeating && typeof s.id === 'string').map(s => ({
    ...entity, key: `${entity.key}:${s.id}`, label: `${definition.name} — ${s.title || s.id}`,
    description: 'One row per sublist line. Parent values repeat for each line.',
    from: `custom_records r CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.data -> ${queryLiteral(s.id)}, '[]'::jsonb)) WITH ORDINALITY AS line(data, ordinal)`,
    columns: [...base, ...fields, { key: 'line_number', label: 'Line number', kind: 'number' as const, expr: 'line.ordinal' },
      ...(Array.isArray(s.fields) ? s.fields : []).flatMap((f: Parameters<typeof customFieldColumn>[0]) => { const c = customFieldColumn(f, 'line.data', 'line_'); return c ? [c] : [] })],
  }))]
}
