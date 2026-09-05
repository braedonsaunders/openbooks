import { validateCustomFieldDefinitionShape } from '@openbooks/customization'
import { lintRecordFields } from '../record-schema'

/**
 * Bundle object provisioning. Any bundle file
 * matching objects/*.json declares a platform object the install should
 * provision:
 *
 *   { "type": "record_type",  key, name, pluralName, iconKey?, showInNav?, fields }
 *   { "type": "custom_field", targetTable, targetKind?, key, label, fieldType, config?, isRequired? }
 *
 * Parsing/validation is pure (this module); the actual upserts run inside the
 * install transaction (store.ts). Ownership rule: an install may CREATE new
 * objects freely, and may UPDATE objects this same App provisioned earlier
 * (tracked in apps.provisioned), but never silently clobbers a user-authored
 * type or field with a colliding key — that's a hard install error.
 */

const SLUG = /^[a-z][a-z0-9-]*$/
export interface RecordTypeSpec {
  key: string
  name: string
  pluralName: string
  iconKey: string
  showInNav: boolean
  fields: unknown[]
}

export interface CustomFieldSpec {
  targetTable: string
  targetKind: string | null
  key: string
  label: string
  fieldType: string
  config: Record<string, unknown>
  isRequired: boolean
}

export interface ParsedObjects {
  recordTypes: RecordTypeSpec[]
  customFields: CustomFieldSpec[]
  errors: string[]
}

/** Parse + validate every objects/*.json file in a bundle. Never throws. */
export function parseObjectSpecs(files: { path: string; content: string; isBinary?: boolean }[]): ParsedObjects {
  const out: ParsedObjects = { recordTypes: [], customFields: [], errors: [] }
  const seenTypes = new Set<string>()
  const seenFields = new Set<string>()

  for (const f of files) {
    if (!/^objects\/[^/]+\.json$/.test(f.path)) continue
    if (f.isBinary) {
      out.errors.push(`${f.path}: must be a JSON text file`)
      continue
    }
    let spec: Record<string, unknown>
    try {
      spec = JSON.parse(f.content)
    } catch {
      out.errors.push(`${f.path}: invalid JSON`)
      continue
    }
    if (spec?.type === 'record_type') {
      const key = String(spec.key ?? '')
      if (!SLUG.test(key)) { out.errors.push(`${f.path}: record_type key must be a slug`); continue }
      if (seenTypes.has(key)) { out.errors.push(`${f.path}: duplicate record_type key "${key}"`); continue }
      const name = String(spec.name ?? '').trim()
      const pluralName = String(spec.pluralName ?? name).trim()
      if (!name) { out.errors.push(`${f.path}: record_type needs a name`); continue }
      const lint = lintRecordFields(spec.fields, name)
      if (!lint.success) {
        out.errors.push(`${f.path}: invalid fields — ${lint.issues[0]?.message ?? 'schema error'}`)
        continue
      }
      seenTypes.add(key)
      out.recordTypes.push({
        key,
        name,
        pluralName,
        iconKey: typeof spec.iconKey === 'string' ? spec.iconKey : 'grid',
        showInNav: spec.showInNav !== false,
        fields: lint.sections as unknown[],
      })
    } else if (spec?.type === 'custom_field') {
      const definitionError = validateCustomFieldDefinitionShape(spec)
      if (definitionError) { out.errors.push(`${f.path}: ${definitionError}`); continue }
      const targetTable = String(spec.targetTable ?? '')
      const key = String(spec.key ?? '')
      const fieldType = String(spec.fieldType ?? '')
      const label = String(spec.label ?? '').trim()
      if (!label) { out.errors.push(`${f.path}: custom_field needs a label`); continue }
      const scoped = `${targetTable}:${key}`
      if (seenFields.has(scoped)) { out.errors.push(`${f.path}: duplicate custom_field "${scoped}"`); continue }
      seenFields.add(scoped)
      out.customFields.push({
        targetTable,
        targetKind: typeof spec.targetKind === 'string' && spec.targetKind ? spec.targetKind : null,
        key,
        label,
        fieldType,
        config: (spec.config && typeof spec.config === 'object' ? spec.config : {}) as Record<string, unknown>,
        isRequired: spec.isRequired === true,
      })
    } else {
      out.errors.push(`${f.path}: "type" must be "record_type" or "custom_field"`)
    }
  }
  return out
}
