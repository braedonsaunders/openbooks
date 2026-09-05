import { CUSTOM_FIELD_TARGETS, CUSTOM_FIELD_REFERENCE_TABLES } from './custom-field-targets';

const FIELD_TYPES = ['text', 'long_text', 'number', 'currency', 'date', 'boolean', 'select', 'multi_select', 'reference']

const REFERENCE_TABLES: readonly string[] = CUSTOM_FIELD_REFERENCE_TABLES

/** Structural contract shared by API writes and app bundle parsing. */
export function validateCustomFieldDefinitionShape(body: Record<string, unknown>): string | null {
  const { targetTable, targetKind, key, label, fieldType, config } = body
  if (config !== undefined && config !== null && (typeof config !== 'object' || Array.isArray(config))) return 'config must be an object'
  const target = CUSTOM_FIELD_TARGETS.find((t) => t.table === targetTable)
  if (!target) return 'invalid target table'
  if (targetKind !== undefined && targetKind !== null && (typeof targetKind !== 'string' || !targetKind || !target.kinds.some((kind) => kind.value === targetKind))) {
    return 'invalid target kind for that table'
  }
  if (typeof key !== 'string' || !/^[a-z][a-z0-9_]{1,60}$/.test(key)) {
    return 'key must be snake_case (a-z, 0-9, _)'
  }
  if (typeof label !== 'string' || !label.trim() || label.length > 120) return 'label required'
  if (typeof fieldType !== 'string' || !FIELD_TYPES.includes(fieldType)) return 'invalid field type'
  for (const key of ['isRequired', 'isActive']) {
    if (body[key] !== undefined && typeof body[key] !== 'boolean') return `${key} must be a boolean`
  }
  if (body.sortOrder !== undefined && (typeof body.sortOrder !== 'number' || !Number.isInteger(body.sortOrder) || body.sortOrder < -2147483648 || body.sortOrder > 2147483647)) {
    return 'sortOrder must be a 32-bit integer'
  }
  if (['select', 'multi_select'].includes(String(fieldType))) {
    const opts = (config as { options?: unknown })?.options
    if (!Array.isArray(opts) || opts.length === 0 || opts.some((o) => typeof o !== 'string' || !o.trim())) {
      return 'select fields need at least one option'
    }
    if (new Set(opts).size !== opts.length) return 'select options must be unique'
  }
  if (String(fieldType) === 'reference') {
    const cfg = config as { referenceTable?: unknown } | undefined
    if (typeof cfg?.referenceTable !== 'string' || !REFERENCE_TABLES.includes(cfg.referenceTable)) {
      return 'reference fields need a valid referenceTable (parties, projects, accounts, items)'
    }
  }
  return null
}
