import { sql, type SQL } from 'drizzle-orm'
import { subsidiaryVisibleFilter } from '../subsidiaries'
import { setupEntitySubsidiaryField, setupEntitySubsidiaryReferenceFields, toSnake, type SetupEntity } from './registry'

/** Whether a restricted actor has a subsidiary-owned anchor for this entity. */
export function setupEntityHasSubsidiaryAnchor(entity: SetupEntity): boolean {
  return Boolean(setupEntitySubsidiaryField(entity) || setupEntitySubsidiaryReferenceFields(entity).length)
}

/** Declaration-owned reference source for inherited legal-entity scope. */
export function setupReferenceSubsidiarySource(source: string, alias: string): { from: SQL; subsidiary: SQL; id: SQL; org: SQL } {
  if (source === 'benefit-enrollment-configuration') return {
    from: sql`hrm_benefit_enrollments ${sql.raw(alias)} join worker_employments scoped_employment on scoped_employment.org_id=${sql.raw(`${alias}.org_id`)} and scoped_employment.id=${sql.raw(`${alias}.employment_id`)}`,
    subsidiary: sql`scoped_employment.employer_subsidiary_id`, id: sql.raw(`${alias}.id`), org: sql.raw(`${alias}.org_id`),
  }
  const declarations: Record<string, [string, string]> = {
    'equipment-units': ['equipment_units', 'subsidiary_id'],
    'worker-employments': ['worker_employments', 'employer_subsidiary_id'],
    'benefit-plans': ['hrm_benefit_plans', 'employer_subsidiary_id'],
  }
  const declaration = declarations[source]
  if (!declaration) throw new Error('Setup reference has no legal-entity scope declaration')
  return { from: sql.raw(`${declaration[0]} ${alias}`), subsidiary: sql.raw(`${alias}.${declaration[1]}`), id: sql.raw(`${alias}.id`), org: sql.raw(`${alias}.org_id`) }
}

/** The shared row predicate used by setup list and drawer readers. */
export function setupEntitySubsidiaryFilter(entity: SetupEntity, allowedSubsidiaryIds: ReadonlySet<string> | null): SQL {
  if (allowedSubsidiaryIds === null) return sql``
  const direct = setupEntitySubsidiaryField(entity)
  if (direct) return subsidiaryVisibleFilter(sql.raw(toSnake(direct.key)), allowedSubsidiaryIds)
  const references = setupEntitySubsidiaryReferenceFields(entity)
  if (references.length === 0) return sql`and false`
  return sql.join(references.map((field, index) => {
    const target = setupReferenceSubsidiarySource(field.ref!, `scoped_reference_${index}`)
    return sql`and exists (select 1 from ${target.from} where ${target.id}=${sql.raw(`${entity.table}.${toSnake(field.key)}`)}
      and ${target.org}=${sql.raw(`${entity.table}.org_id`)} ${subsidiaryVisibleFilter(target.subsidiary, allowedSubsidiaryIds, { orgWideNull: field.ref === 'benefit-plans' })})`
  }), sql``)
}
