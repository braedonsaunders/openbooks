import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { defineRoute } from '@/lib/api/route'
import { db } from '@openbooks/engine/platform/db'
import { subsidiaryScopeAllows } from '@openbooks/engine/organization/scope'
import { intercompanyRepresentationsOfParty } from '@openbooks/engine/intercompany'
import { notFound } from '@/lib/api/responses'

export const runtime = 'nodejs'

const query = z.object({ partyId: z.string().uuid() })

/** The subsidiaries a visible party represents as intercompany customer or vendor. */
export const GET = defineRoute({
  permission: 'parties.read',
  feature: 'intercompanyTransactions',
  handler: async ({ request, authz }) => {
    const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams))
    if (!parsed.success) return NextResponse.json({ error: 'a party id is required' }, { status: 400 })
    const party = (await db.execute<{ subsidiary_id: string | null }>(sql`
      select subsidiary_id from parties where org_id = ${authz.user.orgId} and id = ${parsed.data.partyId}`)).rows[0]
    if (!party || !subsidiaryScopeAllows(authz.allowedSubsidiaryIds, party.subsidiary_id, { orgWideNull: true })) {
      return notFound('record')
    }
    return NextResponse.json({ representations: await intercompanyRepresentationsOfParty(authz.user.orgId, parsed.data.partyId) })
  },
})
