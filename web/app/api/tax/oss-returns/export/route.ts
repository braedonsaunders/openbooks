import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { db } from '@openbooks/engine/platform/database'
import { computeOssReturn, ossReturnToCsv } from '@openbooks/engine/tax-returns'

export const runtime = 'nodejs'

const QuerySchema = z.object({
  scheme: z.enum(['union', 'non_union', 'ioss']),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/**
 * Export the prepared OSS return as the generic EU OSS CSV: one row per
 * member state of consumption and rate, corrections flagged with their
 * original quarter. Member-state portal formats are not implemented; the
 * CSV carries every filed figure for portal hand-keying.
 */
export const GET = defineRoute({
  permission: 'reports.read',
  feature: 'crossBorderTax',
  handler: async ({ authz: routeAuthz, request }) => {
    const gate = routeAuthz;
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
      const oss = await computeOssReturn(db, gate.user.orgId, parsed.data)
      const csv = ossReturnToCsv(oss)
      return new NextResponse(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="oss-${parsed.data.scheme}-${parsed.data.from}-${parsed.data.to}.csv"`,
        },
      })
    } catch (e: unknown) {
      return apiErrorResponse(e, { safeStatus: 422 })
    }
  },
});
