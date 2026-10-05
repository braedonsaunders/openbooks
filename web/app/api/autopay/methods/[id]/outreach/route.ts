import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  AutopayError,
  markExpiryOutreachSent,
} from '@openbooks/engine/payments/autopay'
import { defineRoute } from '@/lib/api/route'
import { isUuid } from '@/lib/list-params'

export const runtime = 'nodejs'

const outreachBody = z.object({
  sentOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

/**
 * Record pre-expiry outreach as sent for one stored card. The row leaves the
 * expiring-cards queue; a card updater refresh that moves the expiry clears
 * the stamp, so the new date notifies on its own.
 */
export const POST = defineRoute({
  permission: 'payment_methods.manage',
  feature: 'autopay',
  body: outreachBody,
  opaque: {
    sentOn: "an omitted date records today; the handler defaults an empty body to the current UTC date",
  },
  handler: async ({ authz, body, params: routeParams }) => {
    const { id } = (routeParams ?? {}) as { id?: string }
    if (!id || !isUuid(id)) return NextResponse.json({ error: 'method id is required' }, { status: 400 })
    try {
      await markExpiryOutreachSent(authz.user.orgId, [id], body.sentOn ?? new Date().toISOString().slice(0, 10), authz.user.id)
      return NextResponse.json({ ok: true })
    } catch (e) {
      if (e instanceof AutopayError) return apiErrorResponse(e, { safeStatus: 422 })
      throw e
    }
  },
})
