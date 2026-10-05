import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { db } from '@openbooks/engine/platform/database'
import {
  computeOssReturn,
  ossReturnToCsv,
  ossReturnToMemberState,
  recordOssFxEvidence,
  type OssMemberState,
} from '@openbooks/engine/tax-returns'

export const runtime = 'nodejs'

const QuerySchema = z.object({
  scheme: z.enum(['union', 'non_union', 'ioss']),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  format: z.enum(['generic', 'DE', 'FR', 'NL', 'IE']).default('generic'),
});

const MEMBER_STATE_CONTENT_TYPE: Record<OssMemberState, string> = {
  DE: 'text/csv; charset=utf-8',
  FR: 'text/csv; charset=utf-8',
  NL: 'text/csv; charset=utf-8',
  IE: 'application/xml; charset=utf-8',
};

const MEMBER_STATE_EXTENSION: Record<OssMemberState, string> = {
  DE: 'csv',
  FR: 'csv',
  NL: 'csv',
  IE: 'xml',
};

/**
 * Export the prepared OSS return. The generic EU OSS CSV carries every filed
 * figure for portal hand-keying; the DE/FR/NL CSV and IE XML layouts carry
 * the same harmonized figures grouped for that member state's portal
 * (confirm the portal's current template before upload — layouts change).
 *
 * Every export stores the ECB translation evidence behind the filed euro
 * figures, so the filed return stays reproducible after rate rows change.
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
      format: params.get('format') ?? undefined,
    })
    if (!parsed.success) {
      return NextResponse.json({ error: 'scheme (union|non_union|ioss), from and to (YYYY-MM-DD) are required; format is generic|DE|FR|NL|IE' }, { status: 400 })
    }
    try {
      const oss = await computeOssReturn(db, gate.user.orgId, parsed.data)
      await recordOssFxEvidence(db, gate.user.orgId, gate.user.id, oss)
      if (parsed.data.format === 'generic') {
        const csv = ossReturnToCsv(oss)
        return new NextResponse(csv, {
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="oss-${parsed.data.scheme}-${parsed.data.from}-${parsed.data.to}.csv"`,
          },
        })
      }
      const state = parsed.data.format as OssMemberState
      const body = ossReturnToMemberState(oss, state)
      return new NextResponse(body, {
        headers: {
          'Content-Type': MEMBER_STATE_CONTENT_TYPE[state],
          'Content-Disposition': `attachment; filename="oss-${state.toLowerCase()}-${parsed.data.scheme}-${parsed.data.from}-${parsed.data.to}.${MEMBER_STATE_EXTENSION[state]}"`,
        },
      })
    } catch (e: unknown) {
      return apiErrorResponse(e, { safeStatus: 422 })
    }
  },
});
