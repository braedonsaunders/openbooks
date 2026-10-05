import { sql, type SQL } from 'drizzle-orm'

/** Match a version scope to a work dimension, including descendants when the
 * scope explicitly opts into child values. The scope tables are hierarchical
 * dimensions, so exact equality alone would silently fall through to a less
 * specific rate card for work in a child department/location/class/subsidiary.
 * Callers use the alias `s` for the scope row. */
export function versionScopePredicate(
  orgId: string,
  input: {
    departmentId?: string | null
    subsidiaryId?: string | null | SQL
    locationId?: string | null
    classId?: string | null
  },
) {
  return sql`(
    (s.scope_type = 'department' and (
      s.scope_value_id = ${input.departmentId ?? null}
      or (s.include_children and exists (
        with recursive descendants(id) as (
          select d.id from departments d where d.org_id = ${orgId} and d.id = s.scope_value_id
          union all
          select child.id from departments child join descendants parent on parent.id = child.parent_id
           where child.org_id = ${orgId}
        )
        select 1 from descendants where id = ${input.departmentId ?? null}
      ))
    ))
    or (s.scope_type = 'subsidiary' and (
      s.scope_value_id = ${input.subsidiaryId ?? null}
      or (s.include_children and exists (
        with recursive descendants(id) as (
          select sub.id from subsidiaries sub where sub.org_id = ${orgId} and sub.id = s.scope_value_id
          union all
          select child.id from subsidiaries child join descendants parent on parent.id = child.parent_id
           where child.org_id = ${orgId}
        )
        select 1 from descendants where id = ${input.subsidiaryId ?? null}
      ))
    ))
    or (s.scope_type = 'location' and (
      s.scope_value_id = ${input.locationId ?? null}
      or (s.include_children and exists (
        with recursive descendants(id) as (
          select l.id from locations l where l.org_id = ${orgId} and l.id = s.scope_value_id
          union all
          select child.id from locations child join descendants parent on parent.id = child.parent_id
           where child.org_id = ${orgId}
        )
        select 1 from descendants where id = ${input.locationId ?? null}
      ))
    ))
    or (s.scope_type = 'class' and (
      s.scope_value_id = ${input.classId ?? null}
      or (s.include_children and exists (
        with recursive descendants(id) as (
          select c.id from classes c where c.org_id = ${orgId} and c.id = s.scope_value_id
          union all
          select child.id from classes child join descendants parent on parent.id = child.parent_id
           where child.org_id = ${orgId}
        )
        select 1 from descendants where id = ${input.classId ?? null}
      ))
    ))
  )`
}
