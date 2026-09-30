import { sql } from 'drizzle-orm'
import { toSnake, type SetupEntity } from './registry'

/** The parent comes from the already-authorized record, never a child URL. */
export function setupParentScope(entity: SetupEntity, owner?: { recordKey: string; value: string }) {
  if (owner === undefined) {
    if (entity.parentRecords?.length) throw new Error(`A parent record is required to list ${entity.key}`)
    return null
  }
  const binding = entity.parentRecords?.find((candidate) => candidate.entityKey === owner.recordKey)
  const field = entity.fields.find((candidate) => candidate.key === binding?.fieldKey)
  if (!binding || !field || (field.kind !== 'ref' && field.kind !== 'text') || (field.kind === 'ref' && field.ref !== owner.recordKey) || !owner.value) {
    throw new Error(`Invalid parent binding for ${entity.key}`)
  }
  return {
    predicate: sql`${sql.raw(toSnake(field.key))} = ${owner.value}`,
    fixedValues: Object.fromEntries(entity.parentRecords!.map((parent) => [parent.fieldKey, parent === binding ? owner.value : null])),
  }
}
