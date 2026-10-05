import { NextResponse } from 'next/server'
import { z } from 'zod'
import { detachVariant } from '@openbooks/engine/inventory'
import { defineRoute } from '@/lib/api/route'
import { notFound } from '@/lib/api/responses'
import { isUuid } from '@/lib/list-params'

const itemParams = z.object({ id: z.string() })

/** Detach a variant from its family. The item stays in the catalog. */
export const POST = defineRoute({
  permission: 'items.manage',
  feature: 'itemVariants',
  scope: 'unrestricted',
  params: itemParams,
  handler: async ({ params: { id }, authz: gate }) => {
    if (!isUuid(id)) return notFound('record')
    const result = await detachVariant(gate.user.orgId, gate.user.id, id)
    return NextResponse.json(result)
  },
})
