import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { wipAnalytics } from '../../../../lib/wip-billing'

export const runtime = 'nodejs'

export const GET = defineRoute({
  permission: 'reports.read',
  feature: 'wipBilling',
  handler: async ({ request: req, authz: routeAuthz }) => {
    const gate = routeAuthz;
    try {
        return NextResponse.json({ analytics: await wipAnalytics(gate.user.orgId, new URL(req.url).searchParams.get('asOf') ?? undefined, gate.allowedSubsidiaryIds) })
      } catch (error) {
        return apiErrorResponse(error)
      }
  },
});
