import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { savePartyTaxId } from '@openbooks/engine/src/tax/cross-border-records.ts'
import { isUuid } from '../../../lib/list-params'

export const runtime = 'nodejs'

const POSTBodySchema = z.object({
  partyId: z.string().uuid(),
  scheme: z.enum(['vies', 'hmrc', 'abn', 'gst']),
  value: z.string().min(1).max(40),
});

interface TaxIdRow {
  id: string
  scheme: string
  value: string
  status: string
  checkedAt: string | null
  consultationNumber: string | null
  revalidateAfter: string | null
}

/**
 * Customer tax IDs: list the validated numbers on a customer record, and
 * record a new number for validation. Recording normalizes the number and
 * reuses the standing row when the number is already on file. Writes hold
 * the crossBorderTax feature lock.
 */
export const GET = defineRoute({
  permission: 'parties.read',
  feature: 'crossBorderTax',
  handler: async ({ authz: routeAuthz, request }) => {
    const gate = routeAuthz;
    const partyId = new URL(request.url).searchParams.get('partyId')
    if (!partyId || !isUuid(partyId)) {
      return NextResponse.json({ error: 'partyId (uuid) is required' }, { status: 400 })
    }
    try {
      const rows = (await db.execute<TaxIdRow>(sql`
        select id, scheme, value, status, checked_at::text as "checkedAt",
               consultation_number as "consultationNumber", revalidate_after::text as "revalidateAfter"
          from party_tax_ids
         where org_id = ${gate.user.orgId} and party_id = ${partyId} and is_active
         order by created_at desc`)).rows
      return NextResponse.json({ taxIds: rows })
    } catch (e: unknown) {
      return apiErrorResponse(e, { safeStatus: 422 })
    }
  },
});

export const POST = defineRoute({
  permission: 'parties.manage',
  feature: 'crossBorderTax',
  body: POSTBodySchema,
  handler: async ({ authz: routeAuthz, body: routeBody }) => {
    const gate = routeAuthz;
    const { partyId, scheme, value } = routeBody as { partyId: string; scheme: 'vies' | 'hmrc' | 'abn' | 'gst'; value: string }
    try {
      const saved = await withOrgTransaction(gate.user.orgId, () =>
        savePartyTaxId(db, gate.user.orgId, { partyId, scheme, value }, gate.user.id),
      )
      return NextResponse.json({ ok: true, ...saved })
    } catch (e: unknown) {
      return apiErrorResponse(e, { safeStatus: 422 })
    }
  },
});
