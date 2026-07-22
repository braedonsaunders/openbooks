import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { mulRate } from '@openbooks/engine/src/money.ts'
import { priceItemRate, type PricingPolicy, type RatePrice, type RateTier } from '@openbooks/engine/src/item-rate-pricing.ts'
import { convertBillRate } from './item-rate-currency'

export interface ResolvedItemRate {
  rateBookId: string
  rateVersionId: string
  baseUnit: string
  policy: PricingPolicy
  invoicePresentation: 'summary' | 'rate_components'
  sourceCurrency: string
  targetCurrency: string
  fxRate: string
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
    select p.customer_id, p.starts_on,coalesce(s.base_currency,o.base_currency) as target_currency,
           (select rate_book_id from equipment_units
             where id = ${input.equipmentUnitId ?? null} and org_id = ${input.orgId}) as unit_rate_book_id
      from projects p join orgs o on o.id=p.org_id left join subsidiaries s on s.id=p.subsidiary_id
      where p.id = ${input.projectId} and p.org_id = ${input.orgId}
  `)) as unknown as { rows: { customer_id: string | null; starts_on: string | null; target_currency:string; unit_rate_book_id: string | null }[] }
  const ctx = context.rows[0]
  if (!ctx) return null
  const projectStart = ctx.starts_on ?? input.onDate

  const candidates = (await db.execute(sql`
    with candidates as (
      select a.rate_book_id,a.rate_version_id, 1 as priority, a.effective_from
        from item_rate_book_assignments a
       where a.org_id = ${input.orgId} and a.is_active and a.project_id = ${input.projectId}
         and (a.effective_from is null or a.effective_from <= case when a.date_basis = 'project_start' then ${projectStart} else ${input.onDate} end)
         and (a.effective_to is null or a.effective_to >= case when a.date_basis = 'project_start' then ${projectStart} else ${input.onDate} end)
      union all
      select a.rate_book_id,a.rate_version_id, 2, a.effective_from
        from item_rate_book_assignments a
       where a.org_id = ${input.orgId} and a.is_active and a.customer_id = ${ctx.customer_id}
         and (a.effective_from is null or a.effective_from <= case when a.date_basis = 'project_start' then ${projectStart} else ${input.onDate} end)
         and (a.effective_to is null or a.effective_to >= case when a.date_basis = 'project_start' then ${projectStart} else ${input.onDate} end)
      union all select ${ctx.unit_rate_book_id}::uuid,null::uuid, 3, null::date where ${ctx.unit_rate_book_id}::uuid is not null
      union all
      select a.rate_book_id,a.rate_version_id, 4, a.effective_from
        from item_rate_book_assignments a
       where a.org_id = ${input.orgId} and a.is_active and a.project_id is null and a.customer_id is null
         and (a.effective_from is null or a.effective_from <= case when a.date_basis = 'project_start' then ${projectStart} else ${input.onDate} end)
         and (a.effective_to is null or a.effective_to >= case when a.date_basis = 'project_start' then ${projectStart} else ${input.onDate} end)
      union all select b.id,null::uuid, 5, null::date from item_rate_books b
       where b.org_id = ${input.orgId} and b.is_default and b.is_active
    )
    select rate_book_id,rate_version_id, priority
      from candidates where rate_book_id is not null
     order by priority, effective_from desc nulls last, rate_book_id
  `)) as unknown as { rows: { rate_book_id: string;rate_version_id:string|null; priority: number }[] }

  const profile = (await db.execute(sql`
    select base_unit, pricing_policy, invoice_presentation from item_rate_profiles
     where org_id = ${input.orgId} and item_id = ${input.itemId} and is_active
  `)) as unknown as { rows: { base_unit: string; pricing_policy: PricingPolicy; invoice_presentation: 'summary' | 'rate_components' }[] }
  const p = profile.rows[0]
  if (!p) return null

  for (const candidate of candidates.rows) {
    const version = (await db.execute(sql`
      select v.id,b.currency
        from item_rate_versions v
        join item_rate_books b on b.id = v.rate_book_id and b.is_active
       where v.org_id = ${input.orgId} and v.rate_book_id = ${candidate.rate_book_id}
         and v.status = 'active' and (( ${candidate.rate_version_id}::uuid is not null and v.id=${candidate.rate_version_id}) or
           (${candidate.rate_version_id}::uuid is null and v.effective_from <= ${input.onDate} and (v.effective_to is null or v.effective_to >= ${input.onDate})))
         and exists (select 1 from item_rate_lines l where l.version_id = v.id and l.item_id = ${input.itemId})
       order by v.effective_from desc limit 1
    `)) as unknown as { rows: { id: string;currency:string }[] }
    const rateVersionId = version.rows[0]?.id
    if (!rateVersionId) continue
    const sourceCurrency=version.rows[0]!.currency
    const fxRate=await billRateFx(input.orgId,sourceCurrency,ctx.target_currency,input.onDate)
    if(!fxRate)continue
    const lines = (await db.execute(sql`
      select id, unit_code, unit_name, base_quantity, cost_rate, bill_rate
        from item_rate_lines
       where org_id = ${input.orgId} and version_id = ${rateVersionId} and item_id = ${input.itemId}
       order by base_quantity, sort_order
    `)) as unknown as { rows: any[] }
    const tiers: RateTier[] = lines.rows.map((r) => ({
      id: r.id, unitCode: r.unit_code, unitName: r.unit_name,
      baseQuantity: String(r.base_quantity), costRate: r.cost_rate == null ? null : convertBillRate(String(r.cost_rate),fxRate),
      billRate: r.bill_rate == null ? null : convertBillRate(String(r.bill_rate),fxRate),
    }))
    return {
      rateBookId: candidate.rate_book_id,
      rateVersionId,
      baseUnit: p.base_unit,
      policy: p.pricing_policy,
      invoicePresentation: p.invoice_presentation,
      sourceCurrency,
      targetCurrency:ctx.target_currency,
      fxRate,
      cost: priceItemRate(input.baseQuantity, tiers, 'cost', p.pricing_policy),
      bill: priceItemRate(input.baseQuantity, tiers, 'bill', p.pricing_policy),
    }
  }
  return null
}

/**
 * Stamp bill rates onto approved billable time that doesn't carry one yet —
 * the labor bill-out card. Resolution per entry:
 *   1. Rate book via the standard assignment chain (project > customer > org
 *      assignment > default book), active version covering worked_on, hourly
 *      line for the item (unit 'hour', else lowest base_quantity).
 *   2. Tier: the line's explicit per-time-type rate wins; otherwise
 *      line.bill_rate × timeType.billMultiplier.
 *   3. No book/line → items.default_rate × timeType.billMultiplier.
 * Entries stay untouched when nothing resolves (billing falls back to the
 * item default at invoice time, exactly as before).
 */
export async function snapshotTimeBillRates(
  orgId: string,
  timeEntryIds: string[],
  opts: { dryRun?: boolean } = {},
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>()
  if (timeEntryIds.length === 0) return resolved
  const idArr = `{${timeEntryIds.join(',')}}`
  const rows = (await db.execute(sql`
    select te.id, te.item_id, te.project_id, te.time_type_id, te.worked_on,
           coalesce(tt.bill_multiplier, '1') as bill_multiplier,
           i.default_rate, coalesce(s.base_currency,o.base_currency) as target_currency
      from time_entries te
      left join time_types tt on tt.id = te.time_type_id
      left join items i on i.id = te.item_id
      left join projects p on p.id=te.project_id and p.org_id=te.org_id
      left join subsidiaries s on s.id=p.subsidiary_id and s.org_id=te.org_id
      join orgs o on o.id=te.org_id
     where te.org_id = ${orgId} and te.id = any(${idArr}::uuid[])
       and te.bill_rate is null and te.is_billable and te.item_id is not null`)) as unknown as {
    rows: {
      id: string
      item_id: string
      project_id: string | null
      time_type_id: string | null
      worked_on: string
      bill_multiplier: string
      default_rate: string | null
      target_currency: string
    }[]
  }
  for (const te of rows.rows) {
    const line = (await db.execute(sql`
      with candidates as (
        select a.rate_book_id,a.rate_version_id, 1 as priority, a.effective_from
          from item_rate_book_assignments a
         where a.org_id = ${orgId} and a.is_active and a.project_id = ${te.project_id}
           and (a.effective_from is null or a.effective_from <= case when a.date_basis = 'project_start' then coalesce((select starts_on from projects where id = ${te.project_id}), ${te.worked_on}::date) else ${te.worked_on}::date end)
           and (a.effective_to is null or a.effective_to >= case when a.date_basis = 'project_start' then coalesce((select starts_on from projects where id = ${te.project_id}), ${te.worked_on}::date) else ${te.worked_on}::date end)
        union all
        select a.rate_book_id,a.rate_version_id, 2, a.effective_from
          from item_rate_book_assignments a
         where a.org_id = ${orgId} and a.is_active
           and a.customer_id = (select customer_id from projects where id = ${te.project_id})
           and (a.effective_from is null or a.effective_from <= case when a.date_basis = 'project_start' then coalesce((select starts_on from projects where id = ${te.project_id}), ${te.worked_on}::date) else ${te.worked_on}::date end)
           and (a.effective_to is null or a.effective_to >= case when a.date_basis = 'project_start' then coalesce((select starts_on from projects where id = ${te.project_id}), ${te.worked_on}::date) else ${te.worked_on}::date end)
        union all
        select a.rate_book_id,a.rate_version_id, 3, a.effective_from
          from item_rate_book_assignments a
         where a.org_id = ${orgId} and a.is_active and a.project_id is null and a.customer_id is null
           and (a.effective_from is null or a.effective_from <= case when a.date_basis = 'project_start' then coalesce((select starts_on from projects where id = ${te.project_id}), ${te.worked_on}::date) else ${te.worked_on}::date end)
           and (a.effective_to is null or a.effective_to >= case when a.date_basis = 'project_start' then coalesce((select starts_on from projects where id = ${te.project_id}), ${te.worked_on}::date) else ${te.worked_on}::date end)
        union all select b.id,null::uuid, 4, null::date from item_rate_books b
         where b.org_id = ${orgId} and b.is_default and b.is_active
      )
      select l.id as rate_line_id,l.bill_rate,l.time_type_bill_rates,
             v.id as rate_version_id,c.rate_book_id,b.currency as source_currency
        from candidates c
        join item_rate_versions v on v.rate_book_id = c.rate_book_id and v.status = 'active'
         and ((c.rate_version_id is not null and v.id=c.rate_version_id) or (c.rate_version_id is null and v.effective_from <= ${te.worked_on} and (v.effective_to is null or v.effective_to >= ${te.worked_on})))
        join item_rate_lines l on l.version_id = v.id and l.item_id = ${te.item_id}
        join item_rate_books b on b.id=c.rate_book_id and b.is_active
       order by c.priority, c.effective_from desc nulls last, v.effective_from desc,
                case when l.unit_code = 'hour' then 0 else 1 end, l.base_quantity
       limit 1`)) as unknown as {
      rows: { rate_line_id:string; bill_rate: string | null; time_type_bill_rates: Record<string, string> | null; rate_version_id:string; rate_book_id:string; source_currency:string }[]
    }
    const hit = line.rows[0]
    const explicit = te.time_type_id ? hit?.time_type_bill_rates?.[te.time_type_id] : undefined
    let sourceRate: string | null = null
    if (explicit != null && Number(explicit) >= 0) sourceRate = String(explicit)
    else if (hit?.bill_rate != null) sourceRate = mulRate(String(hit.bill_rate), String(te.bill_multiplier))
    const sourceCurrency = hit?.source_currency ?? te.target_currency
    if (sourceRate == null && te.default_rate != null) sourceRate = mulRate(String(te.default_rate), String(te.bill_multiplier))
    if (sourceRate == null) continue
    const fxRate = await billRateFx(orgId,sourceCurrency,te.target_currency,te.worked_on)
    if (!fxRate) throw new Error(`No spot rate for bill-out ${sourceCurrency}→${te.target_currency} on or before ${te.worked_on}`)
    const rate=convertBillRate(sourceRate,fxRate)
    resolved.set(te.id, rate)
    if (!opts.dryRun) {
      await db.execute(sql`
        update time_entries set bill_rate=${rate},bill_rate_source_rate=${sourceRate},
          bill_rate_source_currency=${sourceCurrency},bill_rate_fx_rate=${fxRate},bill_rate_currency=${te.target_currency},
          bill_rate_book_id=${hit?.rate_book_id??null},bill_rate_version_id=${hit?.rate_version_id??null},bill_rate_line_id=${hit?.rate_line_id??null}
        where id = ${te.id} and org_id = ${orgId} and bill_rate is null`)
    }
  }
  return resolved
}

async function billRateFx(orgId:string,from:string,to:string,onDate:string):Promise<string|null>{
  if(from===to)return '1'
  const result=(await db.execute(sql`
    select rate::text from (
      select rate,as_of,0 priority from fx_rates where org_id=${orgId} and from_currency=${from} and to_currency=${to} and rate_type='spot' and as_of<=${onDate}
      union all
      select (1/rate)::numeric(19,10),as_of,1 from fx_rates where org_id=${orgId} and from_currency=${to} and to_currency=${from} and rate_type='spot' and as_of<=${onDate}
    ) x order by as_of desc,priority limit 1`)) as unknown as {rows:{rate:string}[]}
  return result.rows[0]?.rate??null
}
