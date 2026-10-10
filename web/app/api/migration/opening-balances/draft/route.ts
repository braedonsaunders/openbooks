import { NextResponse } from 'next/server'
import { z } from 'zod'
import { defineRoute } from '@/lib/api/route'
import { draftOpeningBalances, OpeningBalanceRefusal } from '@/lib/migration/opening-balances'

export const runtime = 'nodejs'

const columns = z.object({
  account: z.string().min(1).max(200),
  debit: z.string().min(1).max(200).optional(),
  credit: z.string().min(1).max(200).optional(),
  amount: z.string().min(1).max(200).optional(),
  description: z.string().min(1).max(200).optional(),
})

const body = z.object({
  transferId: z.uuid(),
  columns,
  excludeRows: z.array(z.number().int().positive()).max(200).optional(),
  documentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  memo: z.string().max(500).nullable().optional(),
  subsidiaryId: z.uuid().nullable().optional(),
  balancingAccountId: z.uuid().nullable().optional(),
  accountRemap: z.array(z.object({ from: z.string().min(1).max(200), toAccountId: z.uuid() })).max(50).optional(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,200}$/),
}).strict()

/**
 * POST /api/migration/opening-balances/draft — draft the opening journal
 * from a staged trial balance through the native journal writer and record
 * it on the migration plan. The operator posts the draft from the native
 * journal screen. Replays with the same idempotency key find the same
 * draft instead of drafting twice.
 */
export const POST = defineRoute({
  permission: 'admin.setup.manage',
  scope: 'unrestricted',
  feature: { none: 'Migration planning is organization-wide setup governed by the setup permission.' },
  body,
  handler: async ({ authz, body: request }) => {
    const { idempotencyKey, ...draft } = request
    try {
      const result = await draftOpeningBalances(authz, draft, idempotencyKey)
      return NextResponse.json({ draft: result })
    } catch (error) {
      // Row-level refusals travel with the message (see the preview route).
      if (error instanceof OpeningBalanceRefusal) {
        return NextResponse.json({ error: error.message, issues: error.issues }, { status: error.status })
      }
      throw error
    }
  },
})
