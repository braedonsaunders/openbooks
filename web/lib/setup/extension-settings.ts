import 'server-only'

import { getExtensionSettings, listActiveExtensionContributions, updateExtensionSetting } from '@openbooks/engine/src/extensions/projections.ts'
import type { SetupEntity } from './registry'

/** Extension declarations use the existing setup list and drawer through this data adapter. */
export async function loadExtensionSettingRows(orgId: string) {
  const [declarations, values] = await Promise.all([listActiveExtensionContributions(orgId), getExtensionSettings(orgId)])
  return declarations.flatMap(({ extensionKey, versionId, contribution }) => contribution.kind !== 'setting' ? [] : [{
    id: `${extensionKey}:${contribution.key}`, extension_key: extensionKey, setting_key: contribution.key,
    name: contribution.label, description: contribution.description ?? '', value_type: contribution.valueType,
    value: values[extensionKey]?.[contribution.key] ?? null, extension_version_id: versionId,
  }]).sort((a, b) => a.id.localeCompare(b.id))
}

export function extensionSettingDrawerEntity(entity: SetupEntity, row: Record<string, unknown>): SetupEntity {
  return { ...entity, fields: entity.fields.map((field) => field.key !== 'value' ? field : {
    ...field, kind: row.value_type === 'boolean' ? 'boolean' : row.value_type === 'string' ? 'text' : 'json',
  }) }
}

export async function saveExtensionSettingRow(orgId: string, actorId: string, permissions: readonly string[], body: Record<string, unknown>) {
  const row = (await loadExtensionSettingRows(orgId)).find((candidate) => candidate.id === body.id)
  if (!row) throw new Error('Active extension setting not found')
  if (!Object.hasOwn(body, 'expectedValue') || typeof body.expectedExtensionVersionId !== 'string') {
    throw Object.assign(new Error('Reload this setting before saving changes'), { status: 409 })
  }
  let value = body.value
  if (row.value_type === 'json' || row.value_type === 'number') {
    if (typeof value === 'string') {
      try { value = JSON.parse(value) } catch { throw new Error('Enter a valid JSON value') }
    }
  }
  await updateExtensionSetting({ orgId, actorId, extensionKey: row.extension_key, key: row.setting_key, value,
    reason: typeof body.reason === 'string' ? body.reason : '', effectivePermissions: permissions,
    ...(Object.hasOwn(body, 'expectedValue') ? { expectedValue: body.expectedValue } : {}),
    ...(typeof body.expectedExtensionVersionId === 'string' ? { expectedExtensionVersionId: body.expectedExtensionVersionId } : {}) })
  return { id: row.id }
}
