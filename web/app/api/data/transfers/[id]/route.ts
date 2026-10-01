import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withOrgTransaction } from '@openbooks/engine/platform/database'
import { defineRoute } from '@/lib/api/route'
import { authorizeTransfers, transferFeature } from '@/lib/data-io/transfer-api'
import { loadTransfer, publicTransfer, transferAuthority } from '@/lib/data-io/transfer-store'
import { commandTransfer } from '@/lib/data-io/transfer-commands'
export const runtime = 'nodejs'
const params = z.object({ id: z.uuid() })
export const GET = defineRoute({ authorize: authorizeTransfers, feature: transferFeature, params,
  handler: async ({ authz, params }) => withOrgTransaction(authz.user.orgId, async () => {
    const job = await loadTransfer(authz.user.orgId, params.id)
    await transferAuthority(job, authz)
    return NextResponse.json({ job: publicTransfer(job) }, { headers: { 'Cache-Control': 'no-store' } })
  }),
})
export const POST = defineRoute({ authorize: authorizeTransfers, feature: transferFeature, params,
  body: z.object({ action: z.enum(['finish-upload', 'preview', 'commit', 'cancel', 'retry']), revision: z.number().int().positive(),
    approvalHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    options: z.object({ mapping: z.record(z.string(), z.string()), importMode: z.enum(['insert', 'upsert']), post: z.boolean() }).optional(),
  }),
  handler: async ({ authz, params, body }) => withOrgTransaction(authz.user.orgId, async () =>
    NextResponse.json({ job: await commandTransfer(authz, params.id, body) }, { status: 202, headers: { 'Cache-Control': 'no-store' } })),
})
