import { z } from 'zod'
import { NextResponse } from 'next/server'
import { withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { setStoredValueStatus } from '@openbooks/engine/src/stored-value/accounts.ts'
import { defineRoute } from '@/lib/api/route'
import { apiErrorResponse } from '@/lib/api/error-response'
import { uuidId } from '@/lib/api/json'

export const runtime = 'nodejs'

/**
 * POST /api/stored-value/accounts/[id]/status — freeze, unfreeze or close.
 * Closing needs a zero balance; the remaining value leaves through
 * redemption, breakage or expiry, never by closing over it.
 */
export const POST = defineRoute({
  permission: 'stored_value.manage',
  feature: 'storedValue',
  body: z.object({
    to: z.enum(['active', 'frozen', 'closed']),
    reason: z.string().trim().max(1000).nullable().optional(),
  }).strict(),
  handler: async ({ authz, body, params }) => {
    try {
      const { id } = z.object({ id: uuidId }).parse(params)
      await withOrgTransaction(authz.user.orgId, () =>
        setStoredValueStatus({
          orgId: authz.user.orgId,
          accountId: id,
          to: body.to,
          reason: body.reason ?? null,
          actorId: authz.user.id,
        }),
      )
      return NextResponse.json({ ok: true }, { status: 200 })
    } catch (error) {
      return apiErrorResponse(error)
    }
  },
})
