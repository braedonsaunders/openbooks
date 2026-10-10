import { sql } from 'drizzle-orm'
import type { SetupEntity } from './types'
import { EQUAL_VALUE_CRITERIA_SLOTS } from './hrm-compensation'
import { toSnake } from './registry'

/** Read-side projection/source for registry fields stored in a child relation. */
export function setupReadProjection(entity: SetupEntity, columns?: readonly string[]) {
  if (entity.key === 'work-calendars') {
    const holidays = `coalesce((select jsonb_agg(jsonb_build_object('date', day) order by day) from jsonb_array_elements_text(schedule_calendars.holidays) closure(day)), '[]'::jsonb) as holidays`
    return sql.raw((columns?.length ? columns.map(column => column === 'holidays' ? holidays : column) : ['*', holidays]).join(', '))
  }
  if (entity.key === 'operating-profiles') {
    const derived = {
      definition: '(select v.definition from operating_profile_versions v where v.org_id=operating_profiles.org_id and v.id=operating_profiles.current_version_id) as definition',
      version: '(select v.version from operating_profile_versions v where v.org_id=operating_profiles.org_id and v.id=operating_profiles.current_version_id) as version',
    }
    return sql.raw((columns?.length ? columns.map(c => derived[c as keyof typeof derived] ?? c) : ['*', ...Object.values(derived)]).join(', '))
  }
  if (entity.key === 'dunning-policies') {
    // Export the complete policy in the same structured shape its native
    // editor accepts, including ordered reminders and retry rows.
    const structuredColumns: Record<string, string> = {
      stages: `(select coalesce(jsonb_agg(jsonb_build_object(
        'sequence', s.sequence, 'name', s.name, 'offsetDays', s.offset_days,
        'subjectTemplate', s.subject_template, 'bodyTemplate', s.body_template,
        'escalate', s.escalate) order by s.sequence), '[]'::jsonb)
        from dunning_stages s where s.org_id = dunning_policies.org_id
          and s.policy_id = dunning_policies.id) as stages`,
      ...Object.fromEntries(['retry_offsets_days', 'insufficient_funds_offsets_days'].map((column) => [column,
        `(select coalesce(jsonb_agg(jsonb_build_object('days', days) order by ordinal), '[]'::jsonb)
          from unnest(autopay_${column}) with ordinality as retry(days, ordinal)) as ${column}`])),
      expiry_notice_days: 'autopay_expiry_notice_days as expiry_notice_days',
      final_action: 'autopay_final_action as final_action',
    }
    const projected = (columns?.length ? columns : Object.keys(structuredColumns)).map((column) =>
      structuredColumns[column] ?? column)
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
  if (entity.key === 'work-calendars') return sql.raw('(select schedule_calendars.*, xmin::text as revision from schedule_calendars where project_id is null) schedule_calendars')
  return sql.raw(entity.key === 'pay-components' ? 'pay_components c' : entity.table)
}
