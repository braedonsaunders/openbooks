import { sql, type SQL } from 'drizzle-orm'
import { subsidiaryVisibleFilter } from '../subsidiaries'
import { setupEntitySubsidiaryField, setupEntitySubsidiaryReferenceFields, toSnake, type SetupEntity } from './registry'

/** Whether a restricted actor has a subsidiary-owned anchor for this entity. */
export function setupEntityHasSubsidiaryAnchor(entity: SetupEntity): boolean {
  return Boolean(setupEntitySubsidiaryField(entity) || setupEntitySubsidiaryReferenceFields(entity).length)
}

/** The shared row predicate used by setup list and drawer readers. */
export function setupEntitySubsidiaryFilter(
  entity: SetupEntity,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): SQL {
  if (allowedSubsidiaryIds === null) return sql``
  const direct = setupEntitySubsidiaryField(entity)
  if (direct) return subsidiaryVisibleFilter(sql.raw(toSnake(direct.key)), allowedSubsidiaryIds)
  const references = setupEntitySubsidiaryReferenceFields(entity)
  if (references.length === 0) return sql`and false`
  return sql.join(references.map((field) => sql`
    and exists (select 1 from equipment_units scoped_unit
                 where scoped_unit.id = ${sql.raw(`${entity.table}.${toSnake(field.key)}`)}
                   and scoped_unit.org_id = ${sql.raw(`${entity.table}.org_id`)}
                   ${subsidiaryVisibleFilter(sql`scoped_unit.subsidiary_id`, allowedSubsidiaryIds)})`), sql``)
}
