import { coerceField } from './coerce'
import type { SetupEntity } from './types'

/** The shared form's raw operator values become domain JSON, rather than
 * database-bound JSON text. Validation remains the registry's own grammar. */
export function setupDomainPayload(entity: SetupEntity, values: Record<string, unknown>):
  { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const body: Record<string, unknown> = {}
  for (const field of entity.fields) {
    const result = coerceField(field, values[field.key])
    if ('error' in result) return { ok: false, error: result.error }
    body[field.key] = typeof result.value === 'string' &&
      (field.kind === 'object' || field.kind === 'objectArray' || field.kind === 'json')
      ? JSON.parse(result.value) : result.value
  }
  return { ok: true, body }
}
