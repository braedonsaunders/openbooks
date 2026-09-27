import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { isUuid } from '../../../lib/list-params'
import { createPrebill, listPrebills } from '../../../lib/wip-billing'
const POSTBodySchema1 = z.object({ "notes": z.unknown().optional(), "periodEnd": z.unknown().optional(), "periodStart": z.unknown().optional(), "projectId": z.unknown().optional() }).passthrough();


export const runtime = 'nodejs'

export const GET = defineRoute({
  permission: 'projects.read',
  feature: 'wipBilling',
  handler: async ({ request: req, authz: routeAuthz }) => {
    const gate = routeAuthz;
    const projectId = new URL(req.url).searchParams.get('projectId') ?? undefined
    if (projectId && !isUuid(projectId)) return NextResponse.json({ error: 'invalid projectId' }, { status: 400 })
    return NextResponse.json({ prebills: await listPrebills(gate.user.orgId, projectId, gate.allowedSubsidiaryIds) })
  },
});

export const POST = defineRoute({
  permission: 'projects.manage',
  feature: 'wipBilling',
  body: POSTBodySchema1,
  handler: async ({ request: req, authz: routeAuthz, body: routeBody }) => {
    const gate = routeAuthz;

    const body = (routeBody) as Record<string, unknown> | null
    if (!body || !isUuid(String(body.projectId ?? ''))) {
        return NextResponse.json({ error: 'projectId required' }, { status: 400 })
      }
    try {
        const result = await createPrebill(gate.user.orgId, gate.user.id, {
          projectId: String(body.projectId),
          periodStart: body.periodStart == null ? null : String(body.periodStart),
          periodEnd: String(body.periodEnd ?? ''),
          notes: body.notes == null ? null : String(body.notes),
        }, gate.allowedSubsidiaryIds)
        return NextResponse.json(result, { status: 201 })
      } catch (error) {
        return apiErrorResponse(error)
      }
  },
});
