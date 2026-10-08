import { z } from 'zod'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { notFound } from '@/lib/api/responses'
import {
  loadInternalBilling,
  saveInternalBillingDraft,
} from '@openbooks/engine/internal-billing'
import { internalBillingBody } from '../_schema'

export const runtime = 'nodejs'

const params = z.object({ id: z.string().uuid() })

export const GET = defineRoute({
  permission: 'gl.read',
  feature: 'internalBilling',
  params,
  handler: async ({ authz, params }) => {
    const detail = await loadInternalBilling(authz.user.orgId, params.id, authz.allowedSubsidiaryIds)
    if (!detail) return notFound('record')
    return NextResponse.json(detail)
  },
})

/** Replace a draft's header and lines; `expectedRevision` refuses a stale save. */
export const PATCH = defineRoute({
  permission: 'gl.post',
  feature: 'internalBilling',
  params,
  body: internalBillingBody.extend({ expectedRevision: z.string().nullable().optional() }),
  invalidBodyStatus: 422,
  handler: async ({ authz, params, body }) => {
    const { expectedRevision, ...input } = body
    const saved = await saveInternalBillingDraft({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      id: params.id,
      input,
      expectedRevision: expectedRevision ?? null,
    })
    return NextResponse.json(saved)
  },
})
