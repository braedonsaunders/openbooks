import { sql } from 'drizzle-orm'
import type { SetupEntity } from './registry'

/** Read-side projection/source for registry fields stored in a child relation. */
export function setupReadProjection(entity: SetupEntity, columns?: readonly string[]) {
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
