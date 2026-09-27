import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { canRunReportEntity } from '../../../../../lib/report-authz'
import { loadView, runView } from '../../../../../lib/views'
import { notFound } from "@/lib/api/responses";


export const runtime = 'nodejs'

/** Run a view fresh and return its ReportRunResult (browse live). */
async function legacyPOST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const { user, permissions } = gate
  const { id } = await params
  if (!isUuid(id)) return notFound("record")
  const view = await loadView(user.orgId, id, user.id, permissions)
  if (!view) return notFound("record")
  if (!(await canRunReportEntity(gate, view.query))) {
    return notFound("record")
  }

  try {
    const result = await runView(user.orgId, view.query)
    return NextResponse.json({ result })
  } catch (err) {
    return apiErrorResponse(err)
  }
}

export const POST = defineRoute({
  permission: "reports.read",
  feature: { none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks." },
  params: z.object({ "id": z.string() }),
  handler: async ({ request, params }) => legacyPOST(request as never, { params: Promise.resolve(params as never) } as never),
});
