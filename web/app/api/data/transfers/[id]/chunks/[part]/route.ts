import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withOrgTransaction } from '@openbooks/engine/platform/database'
import { defineRoute } from '@/lib/api/route'
import { authorizeTransfers, boundedTransferChunk, transferFeature } from '@/lib/data-io/transfer-api'
import { uploadTransferPart } from '@/lib/data-io/transfer-commands'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { loadTransfer, transferAuthority } from '@/lib/data-io/transfer-store'
export const runtime = 'nodejs'
export const GET = defineRoute({ authorize: authorizeTransfers, feature: transferFeature,
  params: z.object({ id: z.uuid(), part: z.coerce.number().int().min(0).max(262_144) }),
  handler: async ({ authz, params }) => withOrgTransaction(authz.user.orgId, async () => {
    await transferAuthority(await loadTransfer(authz.user.orgId, params.id), authz)
    const part = (await db.execute<{ sha256: string; bytes: number }>(sql`select sha256,octet_length(data) as bytes from data_transfer_chunks where org_id=${authz.user.orgId} and job_id=${params.id} and direction='source' and part_no=${params.part}`)).rows[0]
    return NextResponse.json({ part }, { headers: { 'Cache-Control': 'no-store' } })
  }),
})
export const PUT = defineRoute({ authorize: authorizeTransfers, feature: transferFeature,
  params: z.object({ id: z.uuid(), part: z.coerce.number().int().min(0).max(262_144) }),
  handler: async ({ authz, params, request }) => {
    const bytes = await boundedTransferChunk(request)
    return withOrgTransaction(authz.user.orgId, async () => NextResponse.json({ job: await uploadTransferPart(authz, params.id, params.part, bytes) }, { headers: { 'Cache-Control': 'no-store' } }))
  },
})
