import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  activateWarehouse,
  getWarehouse,
  retireWarehouse,
  suspendWarehouse,
} from '@openbooks/engine/src/inventory/warehouses.ts'
import { uuidId } from '@/lib/api/json'
import { notFound } from '@/lib/api/responses'
import { defineRoute } from '@/lib/api/route'

const TRANSITIONS = { activate: activateWarehouse, suspend: suspendWarehouse, retire: retireWarehouse } as const

/**
 * Move a warehouse through its lifecycle. An illegal move, a missing reason
 * or a retirement with stock on hand is refused by the engine with its code
 * and remedy.
 */
export const POST = defineRoute({
  permission: 'items.warehouses',
  feature: 'warehousing',
  scope: 'unrestricted',
  params: z.object({ id: uuidId }),
  body: z.object({
    action: z.enum(['activate', 'suspend', 'retire']),
    reason: z.string().max(500).nullable().optional(),
  }),
  handler: async ({ authz, params: { id }, body }) => {
    if (!(await getWarehouse(db, authz.user.orgId, id))) return notFound('warehouse', id)
    const warehouse = await TRANSITIONS[body.action](authz.user.orgId, authz.user.id, {
      warehouseId: id,
      reason: body.reason ?? null,
    })
    return NextResponse.json({ warehouse })
  },
})
