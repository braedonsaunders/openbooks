import { NextResponse } from 'next/server'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { listAvailableToPromise } from '@openbooks/engine/src/inventory/availability.ts'
import { defineRoute } from '@/lib/api/route'
import { notFound } from '@/lib/api/responses'

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
    const orgId = gate.user.orgId
    const item = (await db.execute<{ id: string; kind: string; code: string | null; name: string }>(sql`
      select id, kind, code, name from items where org_id = ${orgId} and id = ${id}`)).rows[0]
    if (!item || item.kind !== 'kit') return notFound('kit', id)
    const recipe = (await db.execute<{ component_item_id: string }>(sql`
      select distinct component_item_id
        from bom_components
       where org_id = ${orgId} and assembly_item_id = ${id}
         and operation_seq is null and is_byproduct = false
         and (effective_from is null or effective_from <= current_date)
         and (effective_to is null or current_date < effective_to)`)).rows
    const itemIds = [id, ...recipe.map((row) => row.component_item_id)]
    const warehouses = (await db.execute<{ id: string; code: string }>(sql`
      select sl.id, sl.code from warehouses w
        join stock_locations sl on sl.id = w.stock_location_id and sl.org_id = w.org_id
       where w.org_id = ${orgId}
       order by sl.code`)).rows
    const empty = { itemId: id, allLocations: { kit: null, components: [] }, warehouses: [] }
    // No effective recipe: the drawer shows the getting-started state
    // instead of an error page. Any other misconfiguration (an unprofiled
    // component, an unreadable quantity) stays a named refusal.
    if (recipe.length === 0) return NextResponse.json(empty)
    const shape = (rows: { itemId: string; itemLabel: string; onHand: string; committed: string; available: string }[]) => {
      const byId = new Map(rows.map((row) => [row.itemId, row]))
      return {
        kit: byId.get(id) ?? null,
        components: recipe.map((row) => byId.get(row.component_item_id) ?? null),
      }
    }
    const all = await listAvailableToPromise(db, orgId, { itemIds })
    const perWarehouse = []
    for (const warehouse of warehouses) {
      const rows = await listAvailableToPromise(db, orgId, { itemIds, warehouseId: warehouse.id })
      perWarehouse.push({ warehouseId: warehouse.id, warehouseCode: warehouse.code, ...shape(rows) })
    }
    return NextResponse.json({ itemId: id, allLocations: shape(all), warehouses: perWarehouse })
  },
})
