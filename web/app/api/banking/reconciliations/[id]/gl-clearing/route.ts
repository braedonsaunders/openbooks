import { apiErrorResponse } from '@/lib/api/error-response'
import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { NextResponse } from 'next/server'
import { createGlClearingGroup, unmatchGlClearingGroup } from '@openbooks/engine/src/banking/banking.ts'
import { isUuid } from '../../../../../../lib/list-params'
import { notFound } from "@/lib/api/responses";
const POSTBodySchema1 = z.object({ journalLineIds: z.array(z.string().uuid()).min(1) });


export const runtime = 'nodejs'

/** Clear GL-only offsetting lines with no bank counterpart as one zero-sum group. */
export const POST = defineRoute({
  permission: 'banking.reconcile',
  feature: 'banking',
  body: POSTBodySchema1,
  handler: async ({ request: _req, authz: routeAuthz, params: routeParams, body: routeBody }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { user } = gate
    const { id } = await params
    if (!isUuid(id)) return notFound("record")

    const body = (routeBody) as { journalLineIds?: string[] }
    if (
        !Array.isArray(body.journalLineIds) ||
        body.journalLineIds.length === 0 ||
        !body.journalLineIds.every((j) => typeof j === 'string' && isUuid(j))
      ) {
        return NextResponse.json(
          { error: 'journalLineIds is required with at least one entry' },
          { status: 400 },
        )
      }
    try {
        const totals = await createGlClearingGroup(
          { reconciliationId: id, journalLineIds: body.journalLineIds },
          { orgId: user.orgId, userId: user.id, allowedSubsidiaryIds: gate.allowedSubsidiaryIds },
        )
        return NextResponse.json({ ok: true, totals })
      } catch (e) {
        return apiErrorResponse(e)
      }
  },
});

/** Unmatch a GL-only clearing group: ?groupId= */
export const DELETE = defineRoute({
  permission: 'banking.reconcile',
  feature: 'banking',
  handler: async ({ request: req, authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { user } = gate
    const { id } = await params
    const groupId = new URL(req.url).searchParams.get('groupId')
    if (!isUuid(id) || !groupId || !isUuid(groupId)) {
        return NextResponse.json({ error: 'groupId required' }, { status: 400 })
      }
    try {
        const totals = await unmatchGlClearingGroup(
          { reconciliationId: id, groupId },
          { orgId: user.orgId, userId: user.id, allowedSubsidiaryIds: gate.allowedSubsidiaryIds },
        )
        return NextResponse.json({ ok: true, totals })
      } catch (e) {
        return apiErrorResponse(e)
      }
  },
});
