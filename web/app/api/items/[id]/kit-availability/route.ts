import { NextResponse } from 'next/server'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { businessToday } from '@openbooks/engine/platform/business-date/module'
import { listAvailableToPromise } from '@openbooks/engine/inventory'
import { defineRoute } from '@/lib/api/route'
import { notFound } from '@/lib/api/responses'
import { availabilityEntityScope } from '@/lib/availability-report'
import { isUuid } from '../../../../../lib/list-params'

const itemParams = z.object({ id: z.string() })

/**
 * What a kit can still sell, per warehouse and across all locations: the
 * kit's derived availability (the limiting component decides) with every
 * component's own stock beside it, so the operator sees which component
 * runs out first. A kit without a recipe answers with an empty component
 * list rather than an error — the drawer teaches how to start it.
 */
export const GET = defineRoute({
  permission: 'items.read',
  feature: 'inventory',
  params: itemParams,
  handler: async ({ params: { id }, authz: gate }) => {
    if (!isUuid(id)) return notFound('record')
    const orgId = gate.user.orgId
    const item = (await db.execute<{ id: string; kind: string; code: string | null; name: string }>(sql`
      select id, kind, code, name from items where org_id = ${orgId} and id = ${id}`, 'objects'))[0]
    if (!item || item.kind !== 'kit') return notFound('kit', id)
    const entity = await availabilityEntityScope(gate, undefined)
    if (!entity.selectedId) return NextResponse.json({ itemId: id, allLocations: { kit: null, components: [] }, warehouses: [] })
    const subsidiaryId = entity.selectedId
    const businessDate = await businessToday(orgId)
    const recipe = await db.execute<{ component_item_id: string }>(sql`
      select distinct component_item_id
        from bom_components
       where org_id = ${orgId} and assembly_item_id = ${id}
         and operation_seq is null and is_byproduct = false
         and (effective_from is null or effective_from <= ${businessDate}::date)
         and (effective_to is null or ${businessDate}::date < effective_to)`, 'objects')
    const itemIds = [id, ...recipe.map((row) => row.component_item_id)]
    const empty = { itemId: id, allLocations: { kit: null, components: [] }, warehouses: [] }
    // No effective recipe: the drawer shows the getting-started state
    // instead of an error page. Any other misconfiguration (an unprofiled
    // component, an unreadable quantity) stays a named refusal.
    if (recipe.length === 0) return NextResponse.json(empty)
    const warehouses = await db.execute<{ id: string; code: string }>(sql`
      select sl.id, sl.code from warehouses w
        join stock_locations sl on sl.id = w.stock_location_id and sl.org_id = w.org_id
        join locations location on location.id = sl.location_id and location.org_id = sl.org_id
       where w.org_id = ${orgId}
         and (
           location.subsidiary_id is null
           or location.subsidiary_id = ${subsidiaryId}::uuid
           or (location.subsidiary_include_children and location.subsidiary_id in (
             with recursive ancestors(id) as (
               select parent_id from subsidiaries where org_id = ${orgId} and id = ${subsidiaryId}::uuid
               union all
               select subsidiary.parent_id from subsidiaries subsidiary
                 join ancestors on subsidiary.id = ancestors.id
                where subsidiary.parent_id is not null
             )
             select id from ancestors where id is not null
           ))
         )
       order by sl.code`, 'objects')
    const shape = (rows: { itemId: string; itemLabel: string; onHand: string; committed: string; available: string }[]) => {
      const byId = new Map(rows.map((row) => [row.itemId, row]))
      return {
        kit: byId.get(id) ?? null,
        components: recipe.map((row) => byId.get(row.component_item_id) ?? null),
      }
    }
    // Availability nets reservations inside one legal entity: read the kit
    // through the operator's entity scope, the same scope the availability
    // report renders, so the drawer never promises another entity's stock.
    const all = await listAvailableToPromise(db, orgId, { subsidiaryId, itemIds, asOfDate: businessDate })
    const perWarehouse = []
    for (const warehouse of warehouses) {
      const rows = await listAvailableToPromise(db, orgId, { subsidiaryId, itemIds, warehouseId: warehouse.id, asOfDate: businessDate })
      perWarehouse.push({ warehouseId: warehouse.id, warehouseCode: warehouse.code, ...shape(rows) })
    }
    return NextResponse.json({ itemId: id, allLocations: shape(all), warehouses: perWarehouse })
  },
})
