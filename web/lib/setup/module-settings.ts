import 'server-only'

import { getModuleSettings, listActiveModuleContributions, updateModuleSetting } from '@openbooks/engine/src/modules/projections.ts'
import type { SetupEntity } from './registry'

/** Module declarations use the existing setup list and drawer through this data adapter. */
export async function loadModuleSettingRows(orgId: string) {
  const [declarations, values] = await Promise.all([listActiveModuleContributions(orgId), getModuleSettings(orgId)])
  return declarations.flatMap(({ moduleKey, versionId, contribution }) => contribution.kind !== 'setting' ? [] : [{
    id: `${moduleKey}:${contribution.key}`, module_key: moduleKey, setting_key: contribution.key,
    name: contribution.label, description: contribution.description ?? '', value_type: contribution.valueType,
    value: values[moduleKey]?.[contribution.key] ?? null, module_version_id: versionId,
  }]).sort((a, b) => a.id.localeCompare(b.id))
}

export function moduleSettingDrawerEntity(entity: SetupEntity, row: Record<string, unknown>): SetupEntity {
  return { ...entity, fields: entity.fields.map((field) => field.key !== 'value' ? field : {
    ...field, kind: row.value_type === 'boolean' ? 'boolean' : row.value_type === 'string' ? 'text' : 'json',
  }) }
}

export async function saveModuleSettingRow(orgId: string, actorId: string, permissions: readonly string[], body: Record<string, unknown>) {
  const row = (await loadModuleSettingRows(orgId)).find((candidate) => candidate.id === body.id)
  if (!row) throw new Error('Active module setting not found')
  if (!Object.hasOwn(body, 'expectedValue') || typeof body.expectedModuleVersionId !== 'string') {
    throw Object.assign(new Error('Reload this setting before saving changes'), { status: 409 })
  }
  let value = body.value
  if (row.value_type === 'json' || row.value_type === 'number') {
    if (typeof value === 'string') {
      try { value = JSON.parse(value) } catch { throw new Error('Enter a valid JSON value') }
    }
  }
  await updateModuleSetting({ orgId, actorId, moduleKey: row.module_key, key: row.setting_key, value,
    reason: typeof body.reason === 'string' ? body.reason : '', effectivePermissions: permissions,
    ...(Object.hasOwn(body, 'expectedValue') ? { expectedValue: body.expectedValue } : {}),
    ...(typeof body.expectedModuleVersionId === 'string' ? { expectedModuleVersionId: body.expectedModuleVersionId } : {}) })
  return { id: row.id }
}
