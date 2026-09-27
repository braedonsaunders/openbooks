import { NextResponse } from 'next/server'
import { z } from 'zod'
import { uuidId } from '@/lib/api/json'
import { notFound } from '@/lib/api/responses'
import { defineRoute } from '@/lib/api/route'
import { orderReviewTemplateOutline } from '../../../../../../../lib/setup/hrm-builders'

export const runtime = 'nodejs'

/**
 * PUT the review-template builder outline: the section order and, per
 * section, the ordered question ids (a question listed under another
 * section moves there). The whole outline is rewritten in one transaction;
 * an outline that no longer matches the stored template answers 409.
 * Row fields are edited through /api/admin/setup/[entity].
 */
export const PUT = defineRoute({
  permission: 'admin.setup.manage',
  feature: 'hrm',
  scope: 'unrestricted',
  params: z.object({ id: uuidId }),
  body: z.object({
    sections: z.array(z.object({ id: uuidId, questionIds: z.array(uuidId).max(500) })).max(200),
  }),
  handler: async ({ authz, params, body }) => {
    const actor = { ...authz.user, permissions: authz.permissions, allowedSubsidiaryIds: authz.allowedSubsidiaryIds }
    const result = await orderReviewTemplateOutline(actor, params.id, body)
    if (result.status === 404) return notFound('review template')
    return NextResponse.json(result.body, { status: result.status })
  },
})
