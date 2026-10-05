import { defineRoute } from '@/lib/api/route'
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { runConsolidationGroup } from '@openbooks/engine/billing'

export const runtime = 'nodejs'

const runBody = z.strictObject({
  groupId: z.string().uuid(),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  autoPost: z.boolean().optional(),
})

/**
 * Run one consolidation group's period on demand — the same run the
 * scheduler tick performs, but operator-initiated from the consolidation
 * setup or the customer Billing tab. The engine holds the idempotency guard:
 * re-running a completed bucket replays its invoice instead of cutting a
 * second one, and every refusal names its remedy in the 422 body.
 */
export const POST = defineRoute({
  permission: 'documents.manage',
  feature: 'consolidatedBilling',
  body: runBody,
  invalidBodyStatus: 400,
  handler: async ({ authz: gate, body }) => {
  try {
    const runs = await runConsolidationGroup(gate.user.orgId, body.groupId, body.periodStart, body.periodEnd, {
      actorId: gate.user.id,
      autoPost: body.autoPost ?? false,
    })
    return NextResponse.json({ runs })
  } catch (error) {
    return apiErrorResponse(error)
  }
  },
})
