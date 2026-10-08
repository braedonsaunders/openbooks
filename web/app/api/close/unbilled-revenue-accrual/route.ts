import { z } from 'zod'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { apiErrorResponse } from '@/lib/api/error-response'
import { PostingError } from '@openbooks/engine/journal/contracts'
import {
  previewUnbilledRevenueAccrual,
  runUnbilledRevenueAccrual,
  UnbilledAccrualError,
} from '@openbooks/engine/projects/unbilled-accrual'

export const runtime = 'nodejs'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/** Exactly one period reference: the period itself or the date it ends. */
const periodRefSchema = z.union([
  z.object({ periodId: z.string().uuid() }).strict(),
  z.object({ periodEnd: isoDate }).strict(),
])

function refusal(error: unknown, request: Request) {
  if (error instanceof UnbilledAccrualError || error instanceof PostingError) {
    return apiErrorResponse(error, { request, safeStatus: 422 })
  }
  return apiErrorResponse(error, { request })
}

/**
 * What posting the period's unbilled revenue accrual would do now: unbilled
 * work at the period end, what is already accrued, and the remaining delta.
 * The accrual is organization-wide, so it requires unrestricted subsidiary
 * visibility.
 */
export const GET = defineRoute({
  permission: 'gl.post',
  feature: 'unbilledRevenueAccrual',
  scope: 'unrestricted',
  handler: async ({ request, authz }) => {
    const search = new URL(request.url).searchParams
    const parsed = periodRefSchema.safeParse(
      search.get('periodId') ? { periodId: search.get('periodId') } : { periodEnd: search.get('periodEnd') ?? '' },
    )
    if (!parsed.success) {
      return NextResponse.json({ error: 'Choose the accounting period to accrue (periodId or periodEnd).' }, { status: 400 })
    }
    try {
      return NextResponse.json(await previewUnbilledRevenueAccrual(authz.user.orgId, parsed.data))
    } catch (error) {
      return refusal(error, request)
    }
  },
})

/**
 * Post the outstanding accrual for the period: the accrual dated the period
 * end and its reversal dated the first day of the next period, in one
 * transaction. Posting again when nothing changed posts nothing.
 */
export const POST = defineRoute({
  permission: 'gl.post',
  feature: 'unbilledRevenueAccrual',
  scope: 'unrestricted',
  body: periodRefSchema,
  handler: async ({ request, authz, body }) => {
    try {
      return NextResponse.json(await runUnbilledRevenueAccrual(authz.user.orgId, authz.user.id, body))
    } catch (error) {
      return refusal(error, request)
    }
  },
})
