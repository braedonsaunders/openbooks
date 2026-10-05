import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import {
  AutopayError,
  retryAttemptNow,
} from '@openbooks/engine/payments/autopay'
import { defineRoute } from '@/lib/api/route'
import { isUuid } from '@/lib/list-params'

export const runtime = 'nodejs'

/**
 * Operator "retry now": charge a soft-declined attempt immediately instead
 * of waiting for the schedule. Hard declines refuse — they never clear on
 * retry, so the operator updates the method instead.
 */
export const POST = defineRoute({
  permission: 'autopay.manage',
  feature: 'autopay',
  handler: async ({ authz, params: routeParams }) => {
    const { id } = (routeParams ?? {}) as { id?: string }
    if (!id || !isUuid(id)) return NextResponse.json({ error: 'attempt id is required' }, { status: 400 })
    try {
      const result = await retryAttemptNow(authz.user.orgId, id, authz.user.id)
      return NextResponse.json(result)
    } catch (e) {
      if (e instanceof AutopayError) return apiErrorResponse(e, { safeStatus: 422 })
      throw e
    }
  },
})
