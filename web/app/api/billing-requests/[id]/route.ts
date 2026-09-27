import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from '@/lib/api/error-response'
import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { cancelBillingRequest } from '../../../../lib/billing-requests'
import { guardProjectsFeature } from '../../../../lib/projects-gate'
import { notFound } from "@/lib/api/responses";

const requestBodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("cancel") }),
]);



export const runtime = 'nodejs'

async function legacyPATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('projects.manage')
  if (gate instanceof NextResponse) return gate
  const feature = await guardProjectsFeature(gate.user.orgId)
  if (feature) return feature
  const { id } = await params
  if (!isUuid(id)) return notFound("record")
  const parsedBody = await parseJsonBody(req, requestBodySchema);
  if (!parsedBody.ok) return parsedBody.response;
  const body = ((parsedBody.data))
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
}

export const PATCH = defineRoute({
  permission: "projects.manage",
  feature: { none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks." },
  params: z.object({ "id": z.string() }),
  body: requestBodySchema,
  handler: async ({ request, body, params }) => {
    const replayHeaders = new Headers(request.headers);
    replayHeaders.delete("content-length");
    const replayRequest = new Request(request.url, { method: request.method, headers: replayHeaders, body: JSON.stringify(body), signal: request.signal });
    return legacyPATCH(replayRequest as never, { params: Promise.resolve(params as never) } as never);
  },
});
