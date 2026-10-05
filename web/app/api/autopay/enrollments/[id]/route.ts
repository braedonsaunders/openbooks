import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  AutopayError,
  cancelEnrollment,
  pauseEnrollment,
  resumeEnrollment,
} from '@openbooks/engine/payments/autopay'
import { defineRoute } from '@/lib/api/route'
import { isUuid } from '@/lib/list-params'
import { guardEnrollmentScope } from '@/lib/autopay-scope'

export const runtime = 'nodejs'

const statusBody = z.object({ status: z.enum(['active', 'paused', 'canceled']) })

/** Move an enrollment through its lifecycle (pause, resume, cancel). */
export const PATCH = defineRoute({
  permission: 'autopay.manage',
  feature: 'autopay',
  body: statusBody,
  handler: async ({ authz, params: routeParams, body }) => {
    const { id } = (routeParams ?? {}) as { id?: string }
    if (!id || !isUuid(id)) return NextResponse.json({ error: 'enrollment id is required' }, { status: 400 })
    const outOfScope = await guardEnrollmentScope(authz, id)
    if (outOfScope) return outOfScope
    try {
      if (body.status === 'paused') await pauseEnrollment(authz.user.orgId, id, authz.user.id)
      else if (body.status === 'canceled') await cancelEnrollment(authz.user.orgId, id, authz.user.id)
      else await resumeEnrollment(authz.user.orgId, id, authz.user.id)
      return NextResponse.json({ ok: true })
    } catch (e) {
      if (e instanceof AutopayError) return apiErrorResponse(e, { safeStatus: 422 })
      throw e
    }
  },
})
