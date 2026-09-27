import { apiErrorResponse } from '@/lib/api/error-response'
import { defineRoute } from '@/lib/api/route';
import { NextResponse } from 'next/server'
import { markReconciled } from '@openbooks/engine/src/banking/banking.ts'
import { isUuid } from '../../../../../../lib/list-params'
import { notFound } from "@/lib/api/responses";


export const runtime = 'nodejs'

/** Sign off a zero-difference session: stamps matched journal lines reconciled. */
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
        const result = await markReconciled(id, {
          orgId: user.orgId,
          userId: user.id,
          allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        })
        return NextResponse.json({ ok: true, ...result })
      } catch (e) {
        return apiErrorResponse(e)
      }
  },
});
