import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { resolveScanResult } from '@openbooks/engine/src/inventory/item-identifiers.ts'
import { uuidId } from '@/lib/api/json'
import { defineRoute } from '@/lib/api/route'

const bodySchema = z.object({
  field: z.enum(['item', 'bin', 'lot', 'serial']),
  value: z.string().max(200),
  customerId: uuidId.optional(),
  itemId: uuidId.optional(),
}).strict()

/** Resolve one exact barcode or keyboard-wedge value inside the caller's org. */
export const POST = defineRoute({
  permission: 'items.read',
  feature: 'barcodeScanning',
  body: bodySchema,
  handler: async ({ authz, body }) => NextResponse.json(
    await resolveScanResult(db, authz.user.orgId, { ...body, allowedSubsidiaryIds: authz.allowedSubsidiaryIds }),
  ),
})
