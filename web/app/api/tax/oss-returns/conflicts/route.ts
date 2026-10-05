import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { db } from '@openbooks/engine/platform/database'
import { findSupplyEvidenceConflicts } from '@openbooks/engine/tax'

export const runtime = 'nodejs'

/**
 * Pre-posting supply-evidence conflicts: unposted cross-border documents
 * whose location signals name more than one country. The OSS console shows
 * this queue next to the prepared return so the operator fixes the evidence
 * before posting; the posting refusal stays authoritative.
 */
export const GET = defineRoute({
  permission: 'reports.read',
  feature: 'crossBorderTax',
  handler: async ({ authz: routeAuthz }) => {
    try {
      const conflicts = await findSupplyEvidenceConflicts(db, routeAuthz.user.orgId)
      return NextResponse.json({ conflicts: conflicts.slice(0, 50) })
    } catch (e: unknown) {
      return apiErrorResponse(e, { safeStatus: 422 })
    }
  },
});
