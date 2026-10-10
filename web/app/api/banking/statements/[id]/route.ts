import { apiErrorResponse } from '@/lib/api/error-response'
import { defineRoute } from '@/lib/api/route';
import { NextResponse } from 'next/server'
import { deleteStatementImport } from '@openbooks/engine/src/banking/banking.ts'
import { isUuid } from '../../../../../lib/list-params'
import { notFound } from "@/lib/api/responses";

export const runtime = 'nodejs'

/** Delete a whole statement import with every line it brought in. Only an
 * untouched import can go — the engine refuses matched, excluded,
 * signed-off-history and duplicate-flagged imports with named remedies. */
export const DELETE = defineRoute({
  permission: 'banking.reconcile',
  feature: 'banking',
  handler: async ({ authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { user } = gate
    const { id } = await params
    if (!isUuid(id)) return notFound("record")

    try {
      const result = await deleteStatementImport(id, {
        orgId: user.orgId,
        userId: user.id,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      })
      return NextResponse.json({ ok: true, deletedLines: result.deletedLines })
    } catch (e) {
      return apiErrorResponse(e)
    }
  },
});
