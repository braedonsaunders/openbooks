import 'server-only';
import { validateCustomFieldDefinitionShape } from '@openbooks/customization';
import { RESERVED_DOCUMENT_FIELD_KEYS } from '@openbooks/engine/src/flows/documents-adapter.ts';
import { validateCustomFieldConfig } from './custom-field-config';
import type { CustomFieldDef } from './custom-fields';

export type ExistingFieldDef = {
  id: string
  updated_at: string
  target_table: string
  target_kind: string | null
  key: string
  label: string
  field_type: string
  config: unknown
  is_required: boolean
  sort_order: number
  is_active: boolean
}

export function validateCustomFieldDefinition(body: Record<string, unknown>, existing?: ExistingFieldDef): string | null {
  const targetTable = body.targetTable === undefined ? existing?.target_table : body.targetTable
  const targetKind = body.targetKind === undefined ? existing?.target_kind : body.targetKind
  const key = body.key === undefined ? existing?.key : body.key
  const label = body.label === undefined ? existing?.label : body.label
  const fieldType = body.fieldType === undefined ? existing?.field_type : body.fieldType
  const config = body.config === undefined ? existing?.config : body.config

  if (existing) {
    if (body.targetTable !== undefined && body.targetTable !== existing.target_table) {
      return 'target table cannot be changed'
    }
    if (body.targetKind !== undefined && (body.targetKind ?? null) !== existing.target_kind) {
      return 'target kind cannot be changed'
    }
    if (body.key !== undefined && body.key !== existing.key) {
      return 'key cannot be changed'
    }
  }

  const shapeError = validateCustomFieldDefinitionShape({ ...body, targetTable, targetKind, key, label, fieldType, config })
  if (shapeError) return shapeError
  // A documents key that collides with a real header field would shadow it in
  // flow condition evaluation and {{token}} interpolation (e.g. a custom
  // `total` feeding an approval threshold). Fail closed at registration.
  if (targetTable === 'documents' && RESERVED_DOCUMENT_FIELD_KEYS.has(String(key))) {
    return 'key conflicts with a built-in document field'
  }
  return validateCustomFieldConfig(fieldType as CustomFieldDef['fieldType'], config)
}

