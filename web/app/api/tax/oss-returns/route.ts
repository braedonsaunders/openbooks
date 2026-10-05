import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { computeOssReturn } from '@openbooks/engine/src/tax-returns/oss-return.ts'

export const runtime = 'nodejs'

const QuerySchema = z.object({
  scheme: z.enum(['union', 'non_union', 'ioss']),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

function queryParams(request: Request): { scheme?: string; from?: string; to?: string } {
  const params = new URL(request.url).searchParams
  return { scheme: params.get('scheme') ?? undefined, from: params.get('from') ?? undefined, to: params.get('to') ?? undefined }
}

/**
 * One-Stop-Shop returns: compute the period return grouped by member state
 * of consumption and rate (with correction lines for earlier quarters), or
 * export it as the generic EU OSS CSV. Filing itself travels through the
 * tax filings workspace; these routes only prepare and export.
 */
export const GET = defineRoute({
  permission: 'reports.read',
  feature: 'crossBorderTax',
  handler: async ({ authz: routeAuthz, request }) => {
    const gate = routeAuthz;
    const parsed = QuerySchema.safeParse(queryParams(request))
    if (!parsed.success) {
      return NextResponse.json({ error: 'scheme (union|non_union|ioss), from and to (YYYY-MM-DD) are required' }, { status: 400 })
    }
    try {
      const oss = await computeOssReturn(db, gate.user.orgId, parsed.data)
      return NextResponse.json(oss)
    } catch (e: unknown) {
      return apiErrorResponse(e, { safeStatus: 422 })
    }
  },
});
