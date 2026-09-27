import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { isUuid } from '../../../../../lib/list-params'
import { releaseWipHold } from '../../../../../lib/wip-billing'
import { notFound } from "@/lib/api/responses";
const PATCHBodySchema1 = z.object({ reason: z.string().trim().min(1) });



export const runtime = 'nodejs'

export const PATCH = defineRoute({
  permission: 'projects.manage',
  feature: 'wipBilling',
  body: PATCHBodySchema1,
  handler: async ({ request: _req, authz: routeAuthz, params: routeParams, body: routeBody }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { id } = await params
    if (!isUuid(id)) return notFound("record")

    const body = (routeBody) as { reason?: string } | null
    try {
        return NextResponse.json(await releaseWipHold(gate.user.orgId, gate.user.id, id, body?.reason ?? '', gate.allowedSubsidiaryIds))
      } catch (error) {
        return apiErrorResponse(error)
      }
  },
});
