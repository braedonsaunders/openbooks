import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { add, mulPercent, sum } from '@openbooks/engine/src/money.ts'

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

export type AdjustmentCategory = 'markup' | 'travel' | 'allowance' | 'minimum' | 'surcharge' | 'other'
export type AdjustmentCalculation = 'percent' | 'fixed' | 'per_hour' | 'per_day' | 'distance' | 'time' | 'text'
export type AdjustmentPresentation = 'included' | 'separate' | 'informational'

export interface AdjustmentTarget {
  targetType: string
  targetValueId: string | null
  targetValueText: string | null
}

export interface ResolvedAdjustment {
  id: string
  code: string
  name: string
  category: AdjustmentCategory
  calculation: AdjustmentCalculation
  /** A percent value is a percentage: `3.75` means 3.75%. */
  value: string | null
  presentation: AdjustmentPresentation
  threshold: string | null
  itemId: string | null
  appliesRegular: boolean
  appliesOvertime: boolean
  appliesDoubleTime: boolean
  sortOrder: number
  targets: AdjustmentTarget[]
}

/** A line the adjustments are measured against. */
export interface AdjustableLine {
  amount: string
  itemId?: string | null
  itemKind?: string | null
  departmentId?: string | null
  /** True when the charge came from billable time rather than a cost document. */
  isLabor?: boolean
  /** Time-type bucket, when the line came from labor. */
  timeKind?: 'regular' | 'overtime' | 'double_time' | null
}

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
  const context = (await db.execute(sql`
    select p.customer_id, p.starts_on, p.subsidiary_id
      from projects p where p.id = ${input.projectId} and p.org_id = ${input.orgId}
  `)) as unknown as {
    rows: { customer_id: string | null; starts_on: string | null; subsidiary_id: string | null }[]
  }
  const ctx = context.rows[0]
  if (!ctx) return []
  const projectStart = ctx.starts_on ?? input.onDate

  // The first candidate card that actually carries adjustments wins. A card
  // with none falls through, so a customer override of prices alone does not
  // silently drop the surcharges configured on the default card.
  const rows = (await db.execute(sql`
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
    ranked as (
      select v.id as version_id,
             row_number() over (order by s.priority, s.dimension_specificity desc,
                                s.effective_from desc nulls last, v.effective_from desc) as rn
        from scoped s
        join item_rate_versions v on v.rate_book_id = s.rate_book_id and v.org_id = ${input.orgId}
         and v.status = 'active'
         and ((s.rate_version_id is not null and v.id = s.rate_version_id)
           or (s.rate_version_id is null and v.effective_from <= ${input.onDate}::date
               and (v.effective_to is null or v.effective_to >= ${input.onDate}::date)))
        join item_rate_books b on b.id = s.rate_book_id and b.is_active
       where exists (select 1 from labor_rate_adjustments a where a.version_id = v.id and a.is_active)
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
  `)) as unknown as { rows: Record<string, unknown>[] }

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
 * Multiple targets are inclusive alternatives. With NO target the adjustment
 * measures the labor on the card it belongs to — a labor rate card's negotiated
 * terms are terms on labor — so an untargeted surcharge can never silently
 * sweep in materials. Widening to materials is an explicit `material` target.
 */
export function lineMatchesAdjustment(line: AdjustableLine, adjustment: ResolvedAdjustment): boolean {
  if (line.timeKind === 'regular' && !adjustment.appliesRegular) return false
  if (line.timeKind === 'overtime' && !adjustment.appliesOvertime) return false
  if (line.timeKind === 'double_time' && !adjustment.appliesDoubleTime) return false
  if (!adjustment.targets.length) return line.isLabor === true
  return adjustment.targets.some((t) => {
    switch (t.targetType) {
      case 'labor': return line.isLabor === true
      case 'material': return line.isLabor !== true
      case 'item': return !!line.itemId && line.itemId === t.targetValueId
      case 'item_kind': return !!line.itemKind && line.itemKind === (t.targetValueText ?? '')
      case 'department': return !!line.departmentId && line.departmentId === t.targetValueId
      // Customer/project/subsidiary targets are already satisfied by the card
      // assignment that selected this adjustment, so they match every line.
      case 'customer': case 'project': case 'subsidiary': case 'location': case 'class': return true
      default: return false
    }
  })
}

export interface AdjustmentCharge {
  adjustment: ResolvedAdjustment
  basis: string
  amount: string
}

/**
 * Price the adjustments that bill as their own invoice line. `included`
 * adjustments are already inside the resolved rates and `informational` ones
 * are display-only, so neither adds an amount here.
 */
export function priceAdjustments(lines: AdjustableLine[], adjustments: ResolvedAdjustment[]): AdjustmentCharge[] {
  const charges: AdjustmentCharge[] = []
  for (const adjustment of adjustments) {
    if (adjustment.presentation !== 'separate') continue
    if (adjustment.calculation !== 'percent' && adjustment.calculation !== 'fixed') continue
    if (!adjustment.value || Number(adjustment.value) === 0) continue

    const matched = lines.filter((l) => lineMatchesAdjustment(l, adjustment))
    if (!matched.length) continue
    const basis = sum(matched.map((l) => l.amount))
    // A threshold is a floor on the basis, not on the charge: below it the
    // negotiated term simply does not trigger.
    if (adjustment.threshold && Number(basis) < Number(adjustment.threshold)) continue

    const amount = adjustment.calculation === 'fixed' ? adjustment.value : mulPercent(basis, adjustment.value, 2)
    if (Number(amount) === 0) continue
    charges.push({ adjustment, basis, amount })
  }
  return charges
}

/**
 * Fold charges for the same adjustment into one invoice line. Departments are
 * resolved separately so each can carry its own agreement, but when they land
 * on the same negotiated term the customer should see a single charge.
 */
export function mergeCharges(charges: AdjustmentCharge[]): AdjustmentCharge[] {
  const byAdjustment = new Map<string, AdjustmentCharge>()
  for (const c of charges) {
    const prior = byAdjustment.get(c.adjustment.id)
    if (!prior) byAdjustment.set(c.adjustment.id, { ...c })
    else { prior.basis = add(prior.basis, c.basis); prior.amount = add(prior.amount, c.amount) }
  }
  return [...byAdjustment.values()].sort((a, b) => a.adjustment.sortOrder - b.adjustment.sortOrder)
}
