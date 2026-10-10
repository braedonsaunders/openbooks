import { NextResponse } from 'next/server'
import { z } from 'zod'
import { defineRoute } from '@/lib/api/route'
import { OpeningBalanceRefusal, previewOpeningBalances } from '@/lib/migration/opening-balances'

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
}).strict()

/**
 * POST /api/migration/opening-balances/preview — build (but do not write)
 * the opening journal a staged trial-balance file would produce. The same
 * native preview the migration assistant reads, so the guided cutover shows
 * exactly what the draft would post. Refuses an unbalanced file unless the
 * operator names the equity account the difference belongs to.
 */
export const POST = defineRoute({
  permission: 'admin.setup.manage',
  scope: 'unrestricted',
  feature: { none: 'Migration planning is organization-wide setup governed by the setup permission.' },
  body,
  handler: async ({ authz, body: request }) => {
    try {
      const preview = await previewOpeningBalances(authz, request)
      return NextResponse.json({ preview })
    } catch (error) {
      // Row-level refusals travel with the message so the guided cutover
      // can list every offending row, not just the first eight the message
      // names. Anything else keeps the factory's typed-refusal handling.
      if (error instanceof OpeningBalanceRefusal) {
        return NextResponse.json({ error: error.message, issues: error.issues }, { status: error.status })
      }
      throw error
    }
  },
})
