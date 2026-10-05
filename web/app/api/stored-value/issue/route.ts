import { z } from 'zod'
import { NextResponse } from 'next/server'
import { withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { toUnits } from '@openbooks/engine/src/money/money.ts'
import { issueStoredValue } from '@openbooks/engine/src/stored-value/accounts.ts'
import { defineRoute } from '@/lib/api/route'
import { apiErrorResponse } from '@/lib/api/error-response'
import { exactMoney, isoDate, uuidId } from '@/lib/api/json'

export const runtime = 'nodejs'

/**
 * POST /api/stored-value/issue — mint a code with a starting balance. The
 * plaintext code returns exactly once; only its salted digest is stored.
 */
export const POST = defineRoute({
  permission: 'stored_value.manage',
  feature: 'storedValue',
  body: z.object({
    programId: uuidId,
    amount: exactMoney(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    customerPartyId: uuidId.nullable().optional(),
    subsidiaryId: uuidId.nullable().optional(),
    expiresOn: isoDate().nullable().optional(),
    debitAccountId: uuidId,
    postingDate: isoDate().optional(),
    memo: z.string().trim().max(1000).nullable().optional(),
    idempotencyKey: z.string().min(8).max(120),
  }).strict(),
  handler: async ({ authz, body }) => {
    try {
      const result = await withOrgTransaction(authz.user.orgId, () =>
        issueStoredValue({
          orgId: authz.user.orgId,
          programId: body.programId,
          amountMinor: toUnits(body.amount),
          currency: body.currency,
          // The engine validates this against the actor's authoritative
          // scope: restricted callers name a visible entity (or default to
          // their single one), never the org root by omission.
          allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
          subsidiaryId: body.subsidiaryId ?? null,
          customerPartyId: body.customerPartyId ?? null,
          expiresOn: body.expiresOn ?? null,
          debitAccountId: body.debitAccountId,
          postingDate: body.postingDate ?? null,
          memo: body.memo ?? null,
          idempotencyKey: body.idempotencyKey,
          actorId: authz.user.id,
        }),
      )
      return NextResponse.json(result, { status: 201 })
    } catch (error) {
      return apiErrorResponse(error)
    }
  },
})
