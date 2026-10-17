import { z } from 'zod'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { notFound } from '@/lib/api/responses'
import { exactMoney, uuidId } from '@/lib/api/json'
import { ScopeNotFoundError } from '@openbooks/engine/organization/scope'
import { isUuid } from '../../../../../../lib/list-params'
import { recordPaymentAndMatch } from '../../../../../../lib/banking-match-candidates'
import { paymentErrorResponse } from '../../../../payments/lib'

export const runtime = 'nodejs'

const recordPaymentBody = z.object({
  reconciliationId: uuidId,
  openLineIds: z.array(uuidId).min(1).max(20),
  /** The open balance shown for each selected line; a change since refuses. */
  expectedOpen: z.record(z.string(), exactMoney()),
})

/**
 * "Record payment and match": records the customer receipt or vendor bill
 * payment an unmatched bank line represents, settling the selected open
 * documents in full through the native payment services, and matches its
 * bank line to the statement line in the same transaction. Posting the
 * payment additionally requires ar.pay or ap.pay for the line's direction.
 */
export const POST = defineRoute({
  permission: 'banking.reconcile',
  feature: 'banking',
  body: recordPaymentBody,
  handler: async ({ authz, params, body }) => {
    const { id } = params as { id: string }
    if (!isUuid(id)) return notFound('record')
    try {
      const result = await recordPaymentAndMatch(
        authz.user.orgId,
        authz.user.id,
        {
          statementLineId: id,
          reconciliationId: body.reconciliationId,
          openLineIds: body.openLineIds,
          expectedOpen: body.expectedOpen,
        },
        authz.allowedSubsidiaryIds,
      )
      return NextResponse.json({ ok: true, ...result })
    } catch (error) {
      if (error instanceof ScopeNotFoundError) return notFound('record')
      return paymentErrorResponse(error)
    }
  },
})
