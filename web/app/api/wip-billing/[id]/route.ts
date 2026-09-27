import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { loadPrebill, transitionPrebill } from '../../../../lib/wip-billing'
import { guardWipBillingFeature } from '../../../../lib/wip-billing-gate'
import { notFound } from "@/lib/api/responses";
const PATCHBodySchema1 = z.object({ "action": z.unknown().optional(), "reason": z.unknown().optional() }).passthrough();



export const runtime = 'nodejs'

export const GET = defineRoute({
  permission: 'projects.read',
  feature: 'wipBilling',
  handler: async ({ request: _req, authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { id } = await params
    if (!isUuid(id)) return notFound("record")
    const prebill = await loadPrebill(gate.user.orgId, id, gate.allowedSubsidiaryIds)
    return prebill ? NextResponse.json({ prebill }) : notFound("record")
  },
});

export const PATCH = defineRoute({
  public: 'session',
  body: PATCHBodySchema1,
  handler: async ({ request: req, params: routeParams, body: routeBody }) => {
    const params = Promise.resolve(routeParams as { id: string });

    const body = (routeBody) as { action?: string; reason?: string } | null
    const permission = body?.action === 'approve' ? 'ar.approve' : 'projects.manage'
    const gate = await guardPermission(permission)
    if (gate instanceof NextResponse) return gate
    const feature = await guardWipBillingFeature(gate.user.orgId)
    if (feature) return feature
    const { id } = await params
    if (!isUuid(id)) return notFound("record")
    if (!body || !['submit', 'return', 'approve', 'void'].includes(String(body.action))) {
        return NextResponse.json({ error: 'unsupported action' }, { status: 400 })
      }
    try {
        const result = await transitionPrebill(
          gate.user.orgId,
          gate.user.id,
          id,
          body.action as 'submit' | 'return' | 'approve' | 'void',
          body.reason,
          gate.allowedSubsidiaryIds,
        )
        return NextResponse.json(result)
      } catch (error) {
        return apiErrorResponse(error)
      }
  },
});
