import { apiErrorResponse } from '@/lib/api/error-response'
import { defineRoute } from '@/lib/api/route';
import { NextResponse } from 'next/server'
import { listSignOffBlockers } from '@openbooks/engine/src/banking/banking.ts'
import { isUuid } from '../../../../../../lib/list-params'
import { notFound } from "@/lib/api/responses";


export const runtime = 'nodejs'

/** Unmatched statement lines through the cutoff that refuse sign-off, oldest first. */
export const GET = defineRoute({
  permission: 'banking.reconcile',
  feature: 'banking',
  handler: async ({ request: _req, authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { user } = gate
    const { id } = await params
    if (!isUuid(id)) return notFound("record")
    try {
        const blockers = await listSignOffBlockers(id, {
          orgId: user.orgId,
          userId: user.id,
          allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        })
        return NextResponse.json({ ok: true, ...blockers })
      } catch (e) {
        return apiErrorResponse(e)
      }
  },
});
