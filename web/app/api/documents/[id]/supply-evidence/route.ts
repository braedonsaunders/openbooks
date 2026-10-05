import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { db, withOrgTransaction } from '@openbooks/engine/platform/database'
import { recordSupplyEvidence } from '@openbooks/engine/tax'

export const runtime = 'nodejs'

const EvidenceSchema = z.object({
  kind: z.enum(['billing_address', 'ip_country', 'card_bin_country', 'bank_country', 'sim_country', 'ship_to']),
  country: z.string().min(2).max(2),
  source: z.string().min(1).max(40),
});

const PUTBodySchema = z.object({
  election: z.object({
    supplyKind: z.enum(['digital_service', 'goods']),
    customerKind: z.enum(['consumer', 'business']),
  }),
  evidence: z.array(EvidenceSchema).max(6),
});

type EvidenceRow = {
  kind: string
  countryCode: string
  source: string
  observedOn: string | null
}

/**
 * Place-of-supply evidence on a draft sales document: read the collected
 * signals with the frozen verdict, or replace the election and signals in
 * one unit. Only derived country codes are stored — never raw IPs, PANs or
 * BINs. Posted documents refuse through the evidence guard.
 */
export const GET = defineRoute({
  permission: 'ar.read',
  feature: 'crossBorderTax',
  params: z.object({ id: z.string().uuid() }),
  handler: async ({ authz: routeAuthz, params }) => {
    const gate = routeAuthz;
    try {
      const doc = (await db.execute<{ custom: { crossBorder?: unknown; crossBorderSupply?: unknown } | null }>(sql`
        select custom from documents where org_id = ${gate.user.orgId} and id = ${params.id}`)).rows[0]
      if (!doc) return NextResponse.json({ error: 'document not found' }, { status: 404 })
      const rows = (await db.execute<EvidenceRow>(sql`
        select kind, country_code as "countryCode", source, observed_on::text as "observedOn"
          from document_supply_evidence
         where org_id = ${gate.user.orgId} and document_id = ${params.id}
         order by kind, source`)).rows
      return NextResponse.json({ election: doc.custom?.crossBorder ?? null, verdict: doc.custom?.crossBorderSupply ?? null, evidence: rows })
    } catch (e: unknown) {
      return apiErrorResponse(e, { safeStatus: 422 })
    }
  },
});

export const PUT = defineRoute({
  permission: 'ar.create',
  feature: 'crossBorderTax',
  params: z.object({ id: z.string().uuid() }),
  body: PUTBodySchema,
  handler: async ({ authz: routeAuthz, params, body: routeBody }) => {
    const gate = routeAuthz;
    const { election, evidence } = routeBody as {
      election: { supplyKind: 'digital_service' | 'goods'; customerKind: 'consumer' | 'business' }
      evidence: { kind: 'billing_address' | 'ip_country' | 'card_bin_country' | 'bank_country' | 'sim_country' | 'ship_to'; country: string; source: string }[]
    }
    try {
      const saved = await withOrgTransaction(gate.user.orgId, () =>
        recordSupplyEvidence(db, gate.user.orgId, params.id, { election, evidence }, gate.user.id),
      )
      return NextResponse.json({ ok: true, ...saved })
    } catch (e: unknown) {
      return apiErrorResponse(e, { safeStatus: 422 })
    }
  },
});
