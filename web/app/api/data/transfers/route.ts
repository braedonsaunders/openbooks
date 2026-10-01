import { NextResponse } from 'next/server'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/platform/database'
import { defineRoute } from '@/lib/api/route'
import { authorizeTransfers, transferFeature } from '@/lib/data-io/transfer-api'
import { createTransfer, transferMetadataScope } from '@/lib/data-io/transfer-store'
import type { TransferSummary } from '@/lib/data-io/transfer-contract'

export const runtime = 'nodejs'
const body = z.object({
  requestKey: z.uuid(), kind: z.enum(['import', 'export']), resource: z.string().min(1).max(200),
  format: z.enum(['csv', 'xlsx', 'json']), filename: z.string().min(1).max(255).regex(/^[^\r\n/\\]+$/),
  bytes: z.number().int().min(0).max(1_099_511_627_776),
  options: z.object({ columns: z.array(z.string()).min(1).max(16_384) }).optional(),
})
export const POST = defineRoute({ authorize: authorizeTransfers, feature: transferFeature, body,
  handler: async ({ authz, body }) => withOrgTransaction(authz.user.orgId, async () => {
    // Serializing creation on the durable request identity also handles a lost response.
    await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${authz.user.orgId}:${authz.user.id}:${body.requestKey}`},0))`)
    const job = await createTransfer(authz, body)
    return NextResponse.json({ job }, { status: 202, headers: { 'Cache-Control': 'no-store' } })
  }),
})
export const GET = defineRoute({ authorize: authorizeTransfers, feature: transferFeature,
  handler: async ({ authz }) => withOrgTransaction(authz.user.orgId, async () => {
    // Recent metadata never exposes source samples or findings after a grant
    // change. Opening the job rechecks its resource authority separately.
    const jobs = (await db.execute<TransferSummary>(sql`select id,kind,file_name as filename,state from data_transfer_jobs
      where org_id=${authz.user.orgId} and actor_id=${authz.user.id} and ${transferMetadataScope(authz.allowedSubsidiaryIds, sql`scope`)}
      order by created_at desc,id desc limit 20`)).rows
    return NextResponse.json({ jobs }, { headers: { 'Cache-Control': 'no-store' } })
  }),
})
