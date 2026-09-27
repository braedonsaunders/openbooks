import { NextResponse } from 'next/server'
import { z } from 'zod'
import { notFound } from '@/lib/api/responses'
import { defineRoute } from '@/lib/api/route'
import { guardSubsidiaryScope } from '@/lib/authz'
import { findReturnAuthorization } from '@/lib/returns'

export const GET = defineRoute({
  permission: 'orders.fulfill',
  feature: 'returnAuthorizations',
  params: z.object({ id: z.string().uuid() }),
  handler: async ({ authz, params: { id } }) => {
    const authorization = await findReturnAuthorization(authz.user.orgId, id, authz.allowedSubsidiaryIds)
    if (!authorization || guardSubsidiaryScope(authz, authorization.subsidiaryId)) return notFound('return_authorization', id)
    return NextResponse.json({ authorization })
  },
})
