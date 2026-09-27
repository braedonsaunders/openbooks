import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from '@/lib/api/error-response'

import { NextResponse } from 'next/server'

import { isUuid } from '../../../../lib/list-params'
import { cancelBillingRequest } from '../../../../lib/billing-requests'
import { guardProjectsFeature } from '../../../../lib/projects-gate'
import { notFound } from "@/lib/api/responses";

const requestBodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("cancel") }),
]);



export const runtime = 'nodejs'



export const PATCH = defineRoute({
  permission: "projects.manage",
  feature: { none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks." },
  params: z.object({ "id": z.string() }),
  body: requestBodySchema,
  handler: async ({ body, params, authz: routeAuthz }) => {

    const gate = routeAuthz

    const feature = await guardProjectsFeature(gate.user.orgId)
    if (feature) return feature
    const { id } = params
    if (!isUuid(id)) return notFound("record")



    if (body?.action === 'cancel') {
      try {
        await cancelBillingRequest(gate.user.orgId, gate.user.id, id, gate.allowedSubsidiaryIds)
        return NextResponse.json({ ok: true })
      } catch (e) {
        if ((e as Error).message === 'Billing request not found') return notFound("record")
        return apiErrorResponse(e)
      }
    }
    return NextResponse.json({ error: 'unsupported action' }, { status: 400 })
  },
});
