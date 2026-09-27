import { NextResponse } from 'next/server'
import { z } from 'zod'
import { notFound } from '@/lib/api/responses'
import { defineRoute } from '@/lib/api/route'
import { guardSubsidiaryScope } from '@/lib/authz'
import { findReturnAuthorization, receiveReturnAuthorization } from '@/lib/returns'

const bodySchema = z.object({
  lines: z.array(z.object({ lineId: z.string().uuid(), received: z.string().max(40) })).min(1).max(500),
})

export const POST = defineRoute({
  permission: 'orders.fulfill',
  feature: 'returnAuthorizations',
  params: z.object({ id: z.string().uuid() }),
  body: bodySchema,
  handler: async ({ authz, params: { id }, body }) => {
    const current = await findReturnAuthorization(authz.user.orgId, id, authz.allowedSubsidiaryIds)
    if (!current || guardSubsidiaryScope(authz, current.subsidiaryId)) return notFound('return_authorization', id)
    const authorization = await receiveReturnAuthorization({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      documentId: id,
      receivedLines: body.lines,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    })
    return NextResponse.json({ authorization })
  },
})
