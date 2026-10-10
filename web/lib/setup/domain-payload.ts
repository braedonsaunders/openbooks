import { coerceField } from './coerce'
import type { SetupEntity } from './types'

/** The shared form's raw operator values become domain JSON, rather than
 * database-bound JSON text. Validation remains the registry's own grammar. */
export function setupDomainPayload(entity: SetupEntity, values: Record<string, unknown>, phase?: 'create' | 'update'):
  { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const body: Record<string, unknown> = {}
  const keys = entity.mutationPath && phase ? phase === 'create' ? entity.mutationCreateKeys : entity.mutationUpdateKeys : undefined
  for (const field of entity.fields) {
    if (keys && !keys.includes(field.key)) continue
    const result = coerceField(field, values[field.key], true, values)
    if ('error' in result) return { ok: false, error: result.error }
    body[field.key] = typeof result.value === 'string' &&
      (field.kind === 'object' || field.kind === 'objectArray' || field.kind === 'json')
      ? JSON.parse(result.value) : result.value
  }
  return { ok: true, body }
}

/** URL identities and server revisions never come from editable aggregate fields. */
export function setupAggregatePayload(entity: SetupEntity, body: Record<string, unknown>, row: Record<string, unknown> | null):
  { ok: true; body: Record<string, unknown> } | { ok: false; error: 'revision' } {
  if (!entity.mutationPath) return { ok: true, body }
  const result = { ...body }
  if (row && entity.mutationRevision) {
    const revision = row[entity.mutationRevision.rowColumn]
    const valid = entity.mutationRevision.format === 'token'
      ? typeof revision === 'string' && /^[0-9A-Za-z:_-]{1,160}$/.test(revision)
      : Number.isSafeInteger(revision) && (revision as number) >= 1
    if (!valid) return { ok: false, error: 'revision' }
    result[entity.mutationRevision.requestKey] = revision
  }
  const keys = row ? entity.mutationUpdateKeys : entity.mutationCreateKeys
  return { ok: true, body: keys ? Object.fromEntries(keys.filter(key => Object.hasOwn(result, key)).map(key => [key, result[key]])) : result }
}
