import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm'
import { taxOssFxEvidence } from '@openbooks/schema'
import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { db } from '@openbooks/engine/platform/database'

export const runtime = 'nodejs'

const QuerySchema = z.object({
  scheme: z.enum(['union', 'non_union', 'ioss']),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/**
 * Stored ECB translation evidence for a prepared return period: one row per
 * source currency with the rate, its date and the reproducibility digest.
 * Empty before the first export of the period — evidence is stored at export.
 */
export const GET = defineRoute({
  permission: 'reports.read',
  feature: 'crossBorderTax',
  handler: async ({ authz: routeAuthz, request }) => {
    const params = new URL(request.url).searchParams
    const parsed = QuerySchema.safeParse({
      scheme: params.get('scheme') ?? undefined,
      from: params.get('from') ?? undefined,
      to: params.get('to') ?? undefined,
    })
    if (!parsed.success) {
      return NextResponse.json({ error: 'scheme (union|non_union|ioss), from and to (YYYY-MM-DD) are required' }, { status: 400 })
    }
    try {
      const rows = await db.select({
        currency: taxOssFxEvidence.currency,
        rate: taxOssFxEvidence.rate,
        rateAsOf: taxOssFxEvidence.rateAsOf,
        rateSource: taxOssFxEvidence.rateSource,
      }).from(taxOssFxEvidence).where(and(
        eq(taxOssFxEvidence.orgId, routeAuthz.user.orgId),
        eq(taxOssFxEvidence.scheme, parsed.data.scheme),
        eq(taxOssFxEvidence.periodFrom, parsed.data.from),
        eq(taxOssFxEvidence.periodTo, parsed.data.to),
      )).orderBy(asc(taxOssFxEvidence.currency))
      return NextResponse.json({ rows })
    } catch (e: unknown) {
      return apiErrorResponse(e, { safeStatus: 422 })
    }
  },
});
