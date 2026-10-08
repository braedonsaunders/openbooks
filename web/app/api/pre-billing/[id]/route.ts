import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import {
  deliverPrebillInvoice,
  loadPrebill,
  sendPrebillToCustomer,
  transitionPrebill,
} from '../../../../lib/pre-billing'
import { guardPreBillingFeature } from '../../../../lib/pre-billing-gate'
import { notFound } from "@/lib/api/responses";

// Approval decisions are not actions here: a submitted worksheet is decided
// in Inbox through Flows, and with no approval flow it approves on submit.
const PATCHBodySchema1 = z.discriminatedUnion('action', [
  z.object({ action: z.literal('submit') }),
  z.object({ action: z.literal('reopen'), reason: z.string().max(2000) }),
  z.object({ action: z.literal('void'), reason: z.string().max(2000) }),
  z.object({ action: z.literal('send_to_customer'), to: z.string().max(320).nullable().optional(), message: z.string().max(2000).nullable().optional() }),
  z.object({ action: z.literal('deliver'), to: z.string().max(320).nullable().optional(), message: z.string().max(2000).nullable().optional() }),
]);

type PatchBody = z.output<typeof PATCHBodySchema1>

/** Sending the invoice is a receivables act; every other step is project billing preparation. */
function permissionFor(action: PatchBody['action']): 'projects.manage' | 'ar.create' {
  return action === 'deliver' ? 'ar.create' : 'projects.manage'
}

export const runtime = 'nodejs'

export const GET = defineRoute({
  permission: 'projects.read',
  feature: 'preBilling',
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
  handler: async ({ request: _req, params: routeParams, body: routeBody }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const body = routeBody as PatchBody
    const gate = await guardPermission(permissionFor(body.action))
    if (gate instanceof NextResponse) return gate
    const feature = await guardPreBillingFeature(gate.user.orgId)
    if (feature) return feature
    const { id } = await params
    if (!isUuid(id)) return notFound("record")
    try {
      switch (body.action) {
        case 'submit':
          return NextResponse.json(await transitionPrebill(gate.user.orgId, gate.user.id, id, 'submit', undefined, gate.allowedSubsidiaryIds))
        case 'reopen':
        case 'void':
          return NextResponse.json(await transitionPrebill(gate.user.orgId, gate.user.id, id, body.action, body.reason, gate.allowedSubsidiaryIds))
        case 'send_to_customer':
          return NextResponse.json(await sendPrebillToCustomer(gate.user.orgId, gate.user.id, id, { to: body.to, message: body.message }, gate.allowedSubsidiaryIds))
        case 'deliver':
          return NextResponse.json(await deliverPrebillInvoice(gate.user.orgId, gate.user.id, id, { to: body.to, message: body.message }, gate.allowedSubsidiaryIds))
      }
    } catch (error) {
      return apiErrorResponse(error)
    }
  },
});
