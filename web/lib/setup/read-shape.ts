import { sql } from 'drizzle-orm'
import type { SetupEntity } from './types'
import { EQUAL_VALUE_CRITERIA_SLOTS } from './hrm-compensation'
import { toSnake } from './registry'

/** Read-side projection/source for registry fields stored in a child relation. */
export function setupReadProjection(entity: SetupEntity, columns?: readonly string[]) {
  if (entity.key === 'dunning-policies') {
    // The collection-policy form names retry fields without the storage
    // namespace; resolve the same columns the native autopay writer saves.
    const autopayColumns = new Set(['retry_offsets_days', 'insufficient_funds_offsets_days', 'expiry_notice_days', 'final_action'])
    const projected = (columns?.length ? columns : [...autopayColumns]).map((column) =>
      autopayColumns.has(column) ? `autopay_${column} as ${column}` : column)
    return sql.raw((columns?.length ? projected : ['*', ...projected]).join(', '))
  }
  if (entity.key === 'hrm-job-levels') {
    const base = sql.raw(columns?.length ? columns.join(', ') : '*')
    const weights = EQUAL_VALUE_CRITERIA_SLOTS.map(([criterion, slot]) => sql`
      (select item->>'weight' from jsonb_array_elements(equal_value_criteria) item
        where item->>'criterion' = ${criterion} limit 1) as ${sql.raw(toSnake(slot))}`)
    return sql`${base}, ${sql.join(weights, sql`, `)}`
  }
  if (entity.key !== 'pay-components') {
    return sql.raw(columns?.length ? columns.join(', ') : '*')
  }
  const base = columns?.length
    ? columns.filter((column) => column !== 'supplemental_wage_category'
      && column !== 'statutory_reporting_category'
      && column !== 'statutory_exemption_category').map((column) => `c.${column}`).join(', ')
    : 'c.*'
  return sql.raw(`${base}, (select ec.supplemental_wage_category
    from pay_component_earning_classifications ec
    where ec.org_id = c.org_id and ec.pay_component_id = c.id) as supplemental_wage_category,
    (select ec.statutory_reporting_category
       from pay_component_earning_classifications ec
      where ec.org_id = c.org_id and ec.pay_component_id = c.id) as statutory_reporting_category,
    (select ec.statutory_exemption_category
       from pay_component_earning_classifications ec
      where ec.org_id = c.org_id and ec.pay_component_id = c.id) as statutory_exemption_category`)
}

export function setupReadSource(entity: SetupEntity) {
  return sql.raw(entity.key === 'pay-components' ? 'pay_components c' : entity.table)
}
