import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import type { AdjustmentCalculation, AdjustmentCategory, AdjustmentPresentation, AdjustmentTarget, ResolvedAdjustment } from './rate-adjustment-pricing'

export * from './rate-adjustment-pricing'


/**
 * Commercial adjustments carried by a rate card — fuel and shift surcharges,
 * negotiated markups, per-diem, travel, minimums.
 *
 * These are ordinary priced terms of a customer agreement, not a property of
 * any one industry: the card that sets a customer's labor rates also sets the
 * percentages layered on top of them. Because a card is assigned per customer,
 * project, and department, the same customer can carry a surcharge on one
 * department's work and none on another's without any per-tenant code.
 */
/**
 * Resolve the adjustments on the rate card that applies to a project's work on
 * a date. Precedence mirrors `resolveItemRate` — project beats customer beats
 * org default, and within each the most dimension-specific assignment wins —
 * so a card and its surcharges can never disagree about which agreement is in
 * force.
 */
export async function resolveRateAdjustments(input: {
  orgId: string
  projectId: string
  onDate: string
  /** Dimensions of the work being priced. They live on the line, not the
   * project, so the same job can carry different agreements per department. */
  departmentId?: string | null
  locationId?: string | null
  classId?: string | null
}): Promise<ResolvedAdjustment[]> {
  const context = (await db.execute<{ customer_id: string | null; starts_on: string | null; subsidiary_id: string | null }>(sql`
    select p.customer_id, p.starts_on, p.subsidiary_id
      from projects p where p.id = ${input.projectId} and p.org_id = ${input.orgId}
  `))
  const ctx = context.rows[0]
  if (!ctx) return []
  const projectStart = ctx.starts_on ?? input.onDate

  // The first candidate card that actually carries adjustments wins. A card
  // with none falls through, so a customer override of prices alone does not
  // silently drop the surcharges configured on the default card.
  const rows = (await db.execute<Record<string, unknown>>(sql`
    with scoped as (
      select a.rate_book_id, a.rate_version_id,
             case when a.project_id is not null then 1
                  when a.customer_id is not null then 2
                  else 4 end as priority,
             (case when a.department_id is not null then 1 else 0 end
              + case when a.subsidiary_id is not null then 1 else 0 end
              + case when a.location_id is not null then 1 else 0 end
              + case when a.class_id is not null then 1 else 0 end) as dimension_specificity,
             a.effective_from
        from item_rate_book_assignments a
       where a.org_id = ${input.orgId} and a.is_active
         and (a.project_id is null or a.project_id = ${input.projectId})
         and (a.customer_id is null or a.customer_id = ${ctx.customer_id})
         and (a.department_id is null or a.department_id = ${input.departmentId ?? null})
         and (a.subsidiary_id is null or a.subsidiary_id = ${ctx.subsidiary_id})
         and (a.location_id is null or a.location_id = ${input.locationId ?? null})
         and (a.class_id is null or a.class_id = ${input.classId ?? null})
         and (a.effective_from is null or a.effective_from <= case when a.date_basis = 'project_start' then ${projectStart}::date else ${input.onDate}::date end)
         and (a.effective_to is null or a.effective_to >= case when a.date_basis = 'project_start' then ${projectStart}::date else ${input.onDate}::date end)
      union all select b.id, null::uuid, 5, 0, null::date from item_rate_books b
       where b.org_id = ${input.orgId} and b.is_default and b.is_active
    ),
    -- A version may restrict itself to certain dimensions. A customer commonly
    -- holds one card per department, so ignoring these would hand a job an
    -- arbitrary department's rates and surcharges. Unscoped cards apply to
    -- everything, and a card naming the work's department outranks them.
    scoped_versions as (
      select v.id as version_id, s.priority, s.dimension_specificity,
             s.effective_from as assigned_from, v.effective_from,
             (select count(*) from labor_rate_version_scopes vs where vs.version_id = v.id) as scope_count
        from scoped s
        join item_rate_versions v on v.rate_book_id = s.rate_book_id and v.org_id = ${input.orgId}
         and v.status = 'active'
         and ((s.rate_version_id is not null and v.id = s.rate_version_id)
           or (s.rate_version_id is null and v.effective_from <= ${input.onDate}::date
               and (v.effective_to is null or v.effective_to >= ${input.onDate}::date)))
        join item_rate_books b on b.id = s.rate_book_id and b.org_id = ${input.orgId} and b.is_active
       where exists (select 1 from labor_rate_adjustments a where a.version_id = v.id and a.is_active)
         -- A PROJECT-scoped assignment names this exact card for this job, which
         -- is the most specific statement of intent there is; its own dimension
         -- scopes cannot then disqualify it.
         and (s.priority = 1
           or not exists (select 1 from labor_rate_version_scopes vs where vs.version_id = v.id)
           or exists (select 1 from labor_rate_version_scopes vs
                       where vs.version_id = v.id
                         and case vs.scope_type
                               when 'department' then vs.scope_value_id = ${input.departmentId ?? null}::uuid
                               when 'subsidiary' then vs.scope_value_id = ${ctx.subsidiary_id}::uuid
                               when 'location' then vs.scope_value_id = ${input.locationId ?? null}::uuid
                               when 'class' then vs.scope_value_id = ${input.classId ?? null}::uuid
                               else false end))
    ),
    ranked as (
      select version_id,
             row_number() over (order by priority, dimension_specificity desc,
                                (scope_count > 0) desc, assigned_from desc nulls last,
                                effective_from desc) as rn
        from scoped_versions
    )
    select a.id, a.code, a.name, a.category, a.calculation, a.value::text, a.presentation,
           a.threshold::text, a.item_id, a.applies_regular, a.applies_overtime,
           a.applies_double_time, a.sort_order,
           coalesce((select jsonb_agg(jsonb_build_object(
                       'targetType', t.target_type, 'targetValueId', t.target_value_id,
                       'targetValueText', t.target_value_text))
                       from labor_rate_adjustment_targets t where t.adjustment_id = a.id), '[]'::jsonb) as targets
      from labor_rate_adjustments a
      join ranked r on r.version_id = a.version_id and r.rn = 1
     where a.org_id = ${input.orgId} and a.is_active
     order by a.sort_order, a.code
  `))

  return rows.rows.map((r) => ({
    id: String(r.id),
    code: String(r.code),
    name: String(r.name),
    category: r.category as AdjustmentCategory,
    calculation: r.calculation as AdjustmentCalculation,
    value: (r.value as string | null) ?? null,
    presentation: r.presentation as AdjustmentPresentation,
    threshold: (r.threshold as string | null) ?? null,
    itemId: (r.item_id as string | null) ?? null,
    appliesRegular: r.applies_regular !== false,
    appliesOvertime: r.applies_overtime !== false,
    appliesDoubleTime: r.applies_double_time !== false,
    sortOrder: Number(r.sort_order ?? 0),
    targets: (r.targets as AdjustmentTarget[]) ?? [],
  }))
}
/**
 * A customer that HOLDS rate cards covering this work but has none in effect on
 * the date has a LAPSE, not an absence of terms: every negotiated surcharge and
 * markup would bill as nothing and understate the invoice with no trace. A
 * customer with no cards at all simply has no terms, which is not a problem.
 */
export async function findLapsedRateCard(input: {
  orgId: string
  projectId: string
  onDate: string
  /** A lapse is per DEPARTMENT: a customer's electrical card covering the date
   *  says nothing about whether their mechanical card has run out. */
  departmentId?: string | null
}): Promise<{ customerId: string; lastEffectiveTo: string | null } | null> {
  const r = (await db.execute<{ customer_id: string; last_effective_to: string | null }>(sql`
    with context as (
      select p.id as project_id, p.customer_id, p.starts_on, p.subsidiary_id
        from projects p
       where p.id = ${input.projectId} and p.org_id = ${input.orgId}
    ),
    scoped as (
      select a.rate_book_id, a.rate_version_id,
             case when a.project_id is not null then 1
                  when a.customer_id is not null then 2
                  else 4 end as priority,
             (case when a.department_id is not null then 1 else 0 end
              + case when a.subsidiary_id is not null then 1 else 0 end
              + case when a.location_id is not null then 1 else 0 end
              + case when a.class_id is not null then 1 else 0 end) as dimension_specificity,
             a.effective_from as assigned_from
        from item_rate_book_assignments a
        cross join context c
       where a.org_id = ${input.orgId} and a.is_active
         and (a.project_id is null or a.project_id = c.project_id)
         and (a.customer_id is null or a.customer_id = c.customer_id)
         and (a.department_id is null or a.department_id = ${input.departmentId ?? null}::uuid)
         and (a.subsidiary_id is null or a.subsidiary_id = c.subsidiary_id)
         and a.location_id is null and a.class_id is null
         and (a.effective_from is null or a.effective_from <=
              case when a.date_basis = 'project_start' then coalesce(c.starts_on, ${input.onDate}::date) else ${input.onDate}::date end)
         and (a.effective_to is null or a.effective_to >=
              case when a.date_basis = 'project_start' then coalesce(c.starts_on, ${input.onDate}::date) else ${input.onDate}::date end)
      union all
      select b.id, null::uuid, 5, 0, null::date
        from item_rate_books b
       where b.org_id = ${input.orgId} and b.is_default and b.is_active
    ),
    candidates as (
      select s.*
        from scoped s
       where exists (
         select 1
           from item_rate_versions v
           join labor_rate_adjustments x on x.version_id = v.id
            and x.is_active and x.presentation = 'separate' and x.value > 0
          where v.rate_book_id = s.rate_book_id and v.org_id = ${input.orgId} and v.status = 'active'
            and (s.rate_version_id is null or v.id = s.rate_version_id)
            and (s.priority = 1
              or not exists (select 1 from labor_rate_version_scopes vs where vs.version_id = v.id)
              or exists (
                select 1 from labor_rate_version_scopes vs
                 where vs.version_id = v.id
                   and case vs.scope_type
                         when 'department' then vs.scope_value_id = ${input.departmentId ?? null}::uuid
                         when 'subsidiary' then vs.scope_value_id = (select subsidiary_id from context)
                         else false
                       end
              ))
       )
    ),
    selected as (
      select *
        from candidates
       order by priority, dimension_specificity desc, assigned_from desc nulls last, rate_book_id
       limit 1
    ),
    coverage as (
      select max(v.effective_to) filter (where v.effective_to < ${input.onDate}::date)::text as last_effective_to,
             count(*) filter (
               where s.rate_version_id is not null
                  or (v.effective_from <= ${input.onDate}::date
                      and (v.effective_to is null or v.effective_to >= ${input.onDate}::date))
             ) as covering_versions
        from selected s
        join item_rate_versions v on v.rate_book_id = s.rate_book_id
         and v.org_id = ${input.orgId} and v.status = 'active'
         and (s.rate_version_id is null or v.id = s.rate_version_id)
       where exists (
         select 1 from labor_rate_adjustments x
          where x.version_id = v.id and x.is_active
            and x.presentation = 'separate' and x.value > 0
       )
         and (s.priority = 1
           or not exists (select 1 from labor_rate_version_scopes vs where vs.version_id = v.id)
           or exists (
             select 1 from labor_rate_version_scopes vs
              where vs.version_id = v.id
                and case vs.scope_type
                      when 'department' then vs.scope_value_id = ${input.departmentId ?? null}::uuid
                      when 'subsidiary' then vs.scope_value_id = (select subsidiary_id from context)
                      else false
                    end
           ))
    )
    select c.customer_id, coverage.last_effective_to
      from context c cross join coverage
     where exists (select 1 from selected)
       and coverage.covering_versions = 0
  `))
  const row = r.rows[0]
  return row ? { customerId: row.customer_id, lastEffectiveTo: row.last_effective_to } : null
}
