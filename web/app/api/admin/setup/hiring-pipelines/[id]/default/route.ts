import { NextResponse } from 'next/server'
import { z } from 'zod'
import { uuidId } from '@/lib/api/json'
import { notFound } from '@/lib/api/responses'
import { defineRoute } from '@/lib/api/route'
import { makeDefaultPipeline } from '../../../../../../../lib/setup/hrm-builders'

export const runtime = 'nodejs'

/**
 * PUT { isDefault: true } makes this pipeline the org default (the funnel
 * new requisitions open on when none is named). The previous default is
 * cleared in the same transaction, so the org never holds two or none.
 */
export const PUT = defineRoute({
  permission: 'admin.setup.manage',
  feature: 'hrm',
  scope: 'unrestricted',
  params: z.object({ id: uuidId }),
  body: z.object({ isDefault: z.literal(true) }),
  handler: async ({ authz, params }) => {
    const actor = { ...authz.user, permissions: authz.permissions, allowedSubsidiaryIds: authz.allowedSubsidiaryIds }
    const result = await makeDefaultPipeline(actor, params.id)
    if (result.status === 404) return notFound('hiring pipeline')
    return NextResponse.json(result.body, { status: result.status })
  },
})
