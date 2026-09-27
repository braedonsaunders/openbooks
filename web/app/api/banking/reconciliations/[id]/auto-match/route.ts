import { apiErrorResponse } from '@/lib/api/error-response'
import { defineRoute } from '@/lib/api/route';
import { NextResponse } from 'next/server'
import { autoMatch } from '@openbooks/engine/src/banking/banking.ts'
import { isUuid } from '../../../../../../lib/list-params'
import { notFound } from "@/lib/api/responses";


export const runtime = 'nodejs'

/** Exact amount + date ≤3d → 0.9, ≤14d → 0.7; each journal line used once. */
export const POST = defineRoute({
  permission: 'banking.reconcile',
  feature: 'banking',
  handler: async ({ request: _req, authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { user } = gate
    const { id } = await params
    if (!isUuid(id)) return notFound("record")
    try {
        const result = await autoMatch(id, {
          orgId: user.orgId,
          userId: user.id,
          allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        })
        return NextResponse.json(result)
      } catch (e) {
        return apiErrorResponse(e)
      }
  },
});
