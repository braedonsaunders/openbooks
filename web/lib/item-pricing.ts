import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'

export interface ResolvedItemPrice {
  unitPrice: string
  currency: string
  source: 'customer_item' | 'customer_level' | 'base_level' | 'simple'
  scheduleId: string | null
  priceLevelId: string | null
  priceLevelName: string | null
  minimumQuantity: string
  quantityBasis: 'line_quantity' | 'overall_item_quantity'
}

/**
 * Resolve one exact selling price. Precedence is intentionally encoded in the
 * query and returned as evidence: customer/item absolute schedule, customer's
 * effective level, base level, then the simple item price in org base currency.
 */
export async function resolveItemPrice(input: {
  orgId: string
  itemId: string
  customerId?: string | null
  currency: string
  lineQuantity: string
  overallItemQuantity?: string | null
  onDate: string
}): Promise<ResolvedItemPrice | null> {
  const currency = input.currency.trim().toUpperCase()
  const overallQuantity = input.overallItemQuantity ?? input.lineQuantity
  const result = await db.execute<{
    schedule_id: string
    price_level_id: string | null
    price_level_name: string | null
    unit_price: string
    minimum_quantity: string
    quantity_basis: 'line_quantity' | 'overall_item_quantity'
    source: 'customer_item' | 'customer_level' | 'base_level'
  }>(sql`
    with assigned_level as (
      -- Membership is the effective-dated window, never current activation:
      -- deactivating an assignment end-dates it (0327), so a late transaction
      -- inside the old window still finds its level.
      select assignment.price_level_id
        from customer_price_level_assignments assignment
       where assignment.org_id = ${input.orgId}
         and assignment.customer_id = ${input.customerId ?? null}
         and assignment.effective_from <= ${input.onDate}::date
         and (assignment.effective_to is null or assignment.effective_to >= ${input.onDate}::date)
       order by assignment.effective_from desc
       limit 1
    ), candidates as (
      select schedule.id, schedule.price_level_id, level.name as price_level_name,
             schedule.quantity_basis,
             case
               when schedule.customer_id = ${input.customerId ?? null} then 1
               when schedule.customer_id is null and schedule.price_level_id = (select price_level_id from assigned_level) then 2
               when schedule.customer_id is null and level.is_base then 3
               else 99
             end as precedence
        from item_price_schedules schedule
        -- Level state as of the transaction date (0327): past dates read the
        -- versioned activation history, today and the future read the current
        -- flag — a dead level must not price new work. Levels are standing
        -- offers (first period opens at -infinity), so creation never ends
        -- coverage of human-backdated schedules; only deactivation does.
        left join price_levels level
          on level.id = schedule.price_level_id and level.org_id = schedule.org_id
         and (case when ${input.onDate}::date < current_date
                   then exists (
                     select 1 from price_level_activation_history history
                      where history.org_id = level.org_id and history.price_level_id = level.id
                        and history.active_from <= ${input.onDate}::date
                        and (history.active_to is null or ${input.onDate}::date < history.active_to)
                   )
                   else level.is_active end)
       where schedule.org_id = ${input.orgId}
         and schedule.item_id = ${input.itemId}
         and schedule.currency = ${currency}
         and schedule.is_active
         and schedule.effective_from <= ${input.onDate}::date
         and (schedule.effective_to is null or schedule.effective_to >= ${input.onDate}::date)
         and (
           schedule.customer_id = ${input.customerId ?? null}
           or (schedule.customer_id is null and schedule.price_level_id = (select price_level_id from assigned_level))
           or (schedule.customer_id is null and level.is_base)
         )
    )
    select candidate.id as schedule_id, candidate.price_level_id, candidate.price_level_name,
           price.unit_price::text, price.minimum_quantity::text, candidate.quantity_basis,
           case candidate.precedence when 1 then 'customer_item' when 2 then 'customer_level' else 'base_level' end as source
      from candidates candidate
      join lateral (
        select item_price_breaks.unit_price, item_price_breaks.minimum_quantity
          from item_price_breaks
         where item_price_breaks.org_id = ${input.orgId}
           and item_price_breaks.schedule_id = candidate.id
           and item_price_breaks.minimum_quantity <= case candidate.quantity_basis
             when 'overall_item_quantity' then ${overallQuantity}::numeric
             else ${input.lineQuantity}::numeric
           end
         order by item_price_breaks.minimum_quantity desc
         limit 1
      ) price on true
     where candidate.precedence < 99
     order by candidate.precedence
     limit 1
  `)
  const winner = result.rows[0]
  if (winner) {
    return {
      unitPrice: winner.unit_price,
      currency,
      source: winner.source,
      scheduleId: winner.schedule_id,
      priceLevelId: winner.price_level_id,
      priceLevelName: winner.price_level_name,
      minimumQuantity: winner.minimum_quantity,
      quantityBasis: winner.quantity_basis,
    }
  }

  const fallback = await db.execute<{ default_rate: string | null; base_currency: string }>(sql`
    select item.default_rate::text, org.base_currency
      from items item join orgs org on org.id = item.org_id
     where item.org_id = ${input.orgId} and item.id = ${input.itemId}
  `)
  const simple = fallback.rows[0]
  if (!simple?.default_rate || simple.base_currency !== currency) return null
  return {
    unitPrice: simple.default_rate,
    currency,
    source: 'simple',
    scheduleId: null,
    priceLevelId: null,
    priceLevelName: null,
    minimumQuantity: '1.0000',
    quantityBasis: 'line_quantity',
  }
}
