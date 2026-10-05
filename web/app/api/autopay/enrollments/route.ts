import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  AutopayError,
  enrollAutopay,
} from '@openbooks/engine/payments/autopay'
import { uuidId } from '@/lib/api/json'
import { defineRoute } from '@/lib/api/route'
import { isUuid } from '@/lib/list-params'
import { db } from '@openbooks/engine/platform/database'
import { sql } from 'drizzle-orm'

export const runtime = 'nodejs'

const enrollBody = z.object({
  partyId: uuidId,
  subscriptionId: uuidId.nullable().optional(),
  paymentMethodId: uuidId.nullable().optional(),
  chargeOnIssue: z.boolean().optional(),
})

/**
 * Autopay enrollment per customer or per subscription. POST enrolls (the
 * method defaults to the customer's default); PATCH moves the lifecycle.
 */
export const GET = defineRoute({
  permission: 'payment_methods.read',
  feature: 'autopay',
  handler: async ({ authz, request }) => {
    const partyId = new URL(request.url).searchParams.get('partyId') ?? ''
    if (!partyId || !isUuid(partyId)) return NextResponse.json({ error: 'partyId is required' }, { status: 400 })
    const rows = (await db.execute(sql`
      select id, party_id as "partyId", subscription_id as "subscriptionId",
             payment_method_id as "paymentMethodId", status,
             charge_on_issue as "chargeOnIssue"
        from autopay_enrollments
       where org_id = ${authz.user.orgId} and party_id = ${partyId} and status <> 'canceled'
       order by created_at desc
    `)).rows
    return NextResponse.json({ enrollments: rows })
  },
})

export const POST = defineRoute({
  permission: 'autopay.manage',
  feature: 'autopay',
  body: enrollBody,
  handler: async ({ authz, body }) => {
    try {
      const enrollment = await enrollAutopay(authz.user.orgId, {
        partyId: body.partyId,
        subscriptionId: body.subscriptionId ?? null,
        paymentMethodId: body.paymentMethodId ?? null,
        chargeOnIssue: body.chargeOnIssue ?? false,
        actorId: authz.user.id,
      })
      return NextResponse.json({ enrollment })
    } catch (e) {
      if (e instanceof AutopayError) return apiErrorResponse(e, { safeStatus: 422 })
      throw e
    }
  },
})


