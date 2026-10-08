import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { isUuid } from '../../../../../lib/list-params'
import { convertPrebill } from '../../../../../lib/pre-billing'
import { notFound } from "@/lib/api/responses";


export const runtime = 'nodejs'

export const POST = defineRoute({
  permission: 'ar.create',
  feature: 'preBilling',
  handler: async ({ request: _req, authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { id } = await params
    if (!isUuid(id)) return notFound("record")
    try {
        return NextResponse.json(await convertPrebill(gate.user.orgId, gate.user.id, id, gate.allowedSubsidiaryIds))
      } catch (error) {
        return apiErrorResponse(error)
      }
  },
});
