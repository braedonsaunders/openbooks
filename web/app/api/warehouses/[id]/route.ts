import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { getWarehouse, listWarehouseLocations, updateWarehouseDetails } from '@openbooks/engine/src/inventory/warehouses.ts'
import { listPutawayRules } from '@openbooks/engine/src/inventory/putaway.ts'
import { uuidId } from '@/lib/api/json'
import { notFound } from '@/lib/api/responses'
import { defineRoute } from '@/lib/api/route'
import { warehouseAddressBody } from '@/lib/warehouses'

const params = z.object({ id: uuidId })
const updateBody = z.object({ name: z.string().trim().min(1).max(200).optional(), ...warehouseAddressBody }).refine((body) => Object.keys(body).length > 0, { message: "At least one field must be provided." })

/** One warehouse with its locations and ordered putaway rules. */
export const GET = defineRoute({
  permission: 'items.read',
  feature: 'warehousing',
  params,
  handler: async ({ authz, params: { id } }) => {
    const orgId = authz.user.orgId
    const warehouse = await getWarehouse(db, orgId, id)
    if (!warehouse) return notFound('warehouse', id)
    return NextResponse.json({
      warehouse,
      locations: await listWarehouseLocations(db, orgId, id),
      putawayRules: await listPutawayRules(db, orgId, id),
    })
  },
})

/** Edit name and address. Status changes go through the lifecycle route. */
export const PATCH = defineRoute({
  permission: 'items.warehouses',
  feature: 'warehousing',
  scope: 'unrestricted',
  params,
  body: updateBody,
  handler: async ({ authz, params: { id }, body }) => {
    if (!(await getWarehouse(db, authz.user.orgId, id))) return notFound('warehouse', id)
    return NextResponse.json({ warehouse: await updateWarehouseDetails(authz.user.orgId, authz.user.id, id, body) })
  },
})
