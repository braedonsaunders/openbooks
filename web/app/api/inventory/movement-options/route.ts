import { z } from 'zod'
import { NextResponse } from 'next/server'
import { listInventoryOperationOptions } from '@openbooks/engine/inventory'
import { defineRoute } from '@/lib/api/route'
import { apiErrorResponse } from '@/lib/api/error-response'
import { inventoryErrorStatus } from '@/lib/api/inventory-errors'
import { guardPermission } from '@/lib/authz'
import { uuidId } from '@/lib/api/json'

export const runtime = 'nodejs'
const querySchema = z.object({ operation: z.enum(['disassemble','reverse']), q: z.string().trim().max(200).optional(), cursor: uuidId.optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).strict()
export const GET = defineRoute({
  authorize: ({ request }) => guardPermission(new URL(request.url).searchParams.get('operation') === 'reverse' ? 'items.reverse' : 'items.post'),
  feature: 'inventory',
  handler: async ({ authz, request }) => {
    const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams))
    if (!query.success) return NextResponse.json({error:query.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')},{status:422})
    try { return NextResponse.json(await listInventoryOperationOptions(authz.user.orgId,authz.user.id,query.data)) }
    catch (error) { return apiErrorResponse(error,{safeStatus:inventoryErrorStatus(error)}) }
  },
})
