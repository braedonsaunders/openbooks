import { NextResponse } from 'next/server'
import { z } from 'zod'
import { uuidId } from '@/lib/api/json'
import { notFound } from '@/lib/api/responses'
import { defineRoute } from '@/lib/api/route'
import { orderPipelineStages } from '../../../../../../../lib/setup/hrm-builders'

export const runtime = 'nodejs'

/**
 * PUT the hiring-pipeline builder stage order: every stage id of the
 * pipeline, first stage first, rewritten in one transaction. A list that
 * no longer matches the stored stages answers 409. Stage fields are
 * edited through /api/admin/setup/[entity].
 */
export const PUT = defineRoute({
  permission: 'admin.setup.manage',
  feature: 'hrm',
  scope: 'unrestricted',
  params: z.object({ id: uuidId }),
  body: z.object({ stageIds: z.array(uuidId).max(200) }),
  handler: async ({ authz, params, body }) => {
    const actor = { ...authz.user, permissions: authz.permissions, allowedSubsidiaryIds: authz.allowedSubsidiaryIds }
    const result = await orderPipelineStages(actor, params.id, body)
    if (result.status === 404) return notFound('hiring pipeline')
    return NextResponse.json(result.body, { status: result.status })
  },
})
