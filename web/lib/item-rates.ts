import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { priceItemRate, type PricingPolicy, type RatePrice, type RateTier } from '@openbooks/engine/src/item-rate-pricing.ts'

export interface ResolvedItemRate {
  rateBookId: string
  rateVersionId: string
  baseUnit: string
  policy: PricingPolicy
  invoicePresentation: 'summary' | 'rate_components'
  cost: RatePrice
  bill: RatePrice
}

/** Resolve project > customer > unit > org assignment > org default, then snapshot the
 * active version covering the usage date. A candidate without this item falls
 * through so a customer card may override only selected items. */
export async function resolveItemRate(input: {
  orgId: string
  projectId: string
  itemId: string
  equipmentUnitId?: string | null
  onDate: string
  baseQuantity: string
}): Promise<ResolvedItemRate | null> {
  const context = (await db.execute(sql`
    select p.customer_id,
           (select rate_book_id from equipment_units
             where id = ${input.equipmentUnitId ?? null} and org_id = ${input.orgId}) as unit_rate_book_id
      from projects p where p.id = ${input.projectId} and p.org_id = ${input.orgId}
  `)) as unknown as { rows: { customer_id: string | null; unit_rate_book_id: string | null }[] }
  const ctx = context.rows[0]
  if (!ctx) return null

  const candidates = (await db.execute(sql`
    with candidates as (
      select a.rate_book_id, 1 as priority, a.effective_from
        from item_rate_book_assignments a
       where a.org_id = ${input.orgId} and a.is_active and a.project_id = ${input.projectId}
         and (a.effective_from is null or a.effective_from <= ${input.onDate})
         and (a.effective_to is null or a.effective_to >= ${input.onDate})
      union all
      select a.rate_book_id, 2, a.effective_from
        from item_rate_book_assignments a
       where a.org_id = ${input.orgId} and a.is_active and a.customer_id = ${ctx.customer_id}
         and (a.effective_from is null or a.effective_from <= ${input.onDate})
         and (a.effective_to is null or a.effective_to >= ${input.onDate})
      union all select ${ctx.unit_rate_book_id}::uuid, 3, null::date where ${ctx.unit_rate_book_id}::uuid is not null
      union all
      select a.rate_book_id, 4, a.effective_from
        from item_rate_book_assignments a
       where a.org_id = ${input.orgId} and a.is_active and a.project_id is null and a.customer_id is null
         and (a.effective_from is null or a.effective_from <= ${input.onDate})
         and (a.effective_to is null or a.effective_to >= ${input.onDate})
      union all select b.id, 5, null::date from item_rate_books b
       where b.org_id = ${input.orgId} and b.is_default and b.is_active
    )
    select rate_book_id, priority
      from candidates where rate_book_id is not null
     order by priority, effective_from desc nulls last, rate_book_id
  `)) as unknown as { rows: { rate_book_id: string; priority: number }[] }

  const profile = (await db.execute(sql`
    select base_unit, pricing_policy, invoice_presentation from item_rate_profiles
     where org_id = ${input.orgId} and item_id = ${input.itemId} and is_active
  `)) as unknown as { rows: { base_unit: string; pricing_policy: PricingPolicy; invoice_presentation: 'summary' | 'rate_components' }[] }
  const p = profile.rows[0]
  if (!p) return null

  for (const candidate of candidates.rows) {
    const version = (await db.execute(sql`
      select v.id
        from item_rate_versions v
        join item_rate_books b on b.id = v.rate_book_id and b.is_active
        join orgs o on o.id = v.org_id and o.base_currency = b.currency
       where v.org_id = ${input.orgId} and v.rate_book_id = ${candidate.rate_book_id}
         and v.status = 'active' and v.effective_from <= ${input.onDate}
         and (v.effective_to is null or v.effective_to >= ${input.onDate})
         and exists (select 1 from item_rate_lines l where l.version_id = v.id and l.item_id = ${input.itemId})
       order by v.effective_from desc limit 1
    `)) as unknown as { rows: { id: string }[] }
    const rateVersionId = version.rows[0]?.id
    if (!rateVersionId) continue
    const lines = (await db.execute(sql`
      select id, unit_code, unit_name, base_quantity, cost_rate, bill_rate
        from item_rate_lines
       where org_id = ${input.orgId} and version_id = ${rateVersionId} and item_id = ${input.itemId}
       order by base_quantity, sort_order
    `)) as unknown as { rows: any[] }
    const tiers: RateTier[] = lines.rows.map((r) => ({
      id: r.id, unitCode: r.unit_code, unitName: r.unit_name,
      baseQuantity: String(r.base_quantity), costRate: r.cost_rate == null ? null : String(r.cost_rate),
      billRate: r.bill_rate == null ? null : String(r.bill_rate),
    }))
    return {
      rateBookId: candidate.rate_book_id,
      rateVersionId,
      baseUnit: p.base_unit,
      policy: p.pricing_policy,
      invoicePresentation: p.invoice_presentation,
      cost: priceItemRate(input.baseQuantity, tiers, 'cost', p.pricing_policy),
      bill: priceItemRate(input.baseQuantity, tiers, 'bill', p.pricing_policy),
    }
  }
  return null
}
