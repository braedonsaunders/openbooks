import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { createWarehouse, listWarehouses } from '@openbooks/engine/src/inventory/warehouses.ts'
import { uuidId } from '@/lib/api/json'
import { created } from '@/lib/api/responses'
import { defineRoute } from '@/lib/api/route'
import { warehouseAddressBody } from '@/lib/warehouses'

const createBody = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  locationId: uuidId,
  ...warehouseAddressBody,
})

/** Warehouses of the organization with their lifecycle status. */
export const GET = defineRoute({
  permission: 'items.read',
  feature: 'warehousing',
  handler: async ({ authz }) => NextResponse.json({ warehouses: await listWarehouses(db, authz.user.orgId) }),
})

/** Create a warehouse in draft; it takes stock only once activated. */
export const POST = defineRoute({
  permission: 'items.warehouses',
  feature: 'warehousing',
  scope: 'unrestricted',
  body: createBody,
  handler: async ({ authz, body }) =>
    created({ warehouse: await createWarehouse(authz.user.orgId, authz.user.id, body) }),
})
