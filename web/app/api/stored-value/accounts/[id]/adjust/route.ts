import { z } from 'zod'
import { NextResponse } from 'next/server'
import { withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { toUnits } from '@openbooks/engine/src/money/money.ts'
import { adjustStoredValue } from '@openbooks/engine/src/stored-value/accounts.ts'
import { defineRoute } from '@/lib/api/route'
import { apiErrorResponse } from '@/lib/api/error-response'
import { exactMoney, isoDate, uuidId } from '@/lib/api/json'

export const runtime = 'nodejs'

/**
 * POST /api/stored-value/accounts/[id]/adjust — correct a balance outside
 * any document. Segregated duty (stored_value.adjust): the reason is
 * mandatory audit evidence, and the offset keeps the correction balanced.
 */
export const POST = defineRoute({
  permission: 'stored_value.adjust',
  feature: 'storedValue',
  body: z.object({
    delta: exactMoney(),
    reason: z.string().trim().min(8).max(1000),
    offsetAccountId: uuidId,
    postingDate: isoDate().optional(),
    idempotencyKey: z.string().min(8).max(120),
  }).strict(),
  handler: async ({ authz, body, params }) => {
    try {
      const { id } = z.object({ id: uuidId }).parse(params)
      const result = await withOrgTransaction(authz.user.orgId, () =>
        adjustStoredValue({
          orgId: authz.user.orgId,
          accountId: id,
          // Visibility is enforced under the row lock before any named
          // balance/status refusal, so a hidden account reads as missing.
          allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
          deltaMinor: toUnits(body.delta),
          reason: body.reason,
          offsetAccountId: body.offsetAccountId,
          postingDate: body.postingDate ?? null,
          idempotencyKey: body.idempotencyKey,
          actorId: authz.user.id,
        }),
      )
      // Ledger units stay exact in the receipt, including balances beyond
      // JavaScript's safe integer range. Native JSON cannot serialize bigint.
      return NextResponse.json({ ...result, balanceMinor: result.balanceMinor.toString() }, { status: 201 })
    } catch (error) {
      return apiErrorResponse(error)
    }
  },
})
