import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";

import { NextResponse } from "next/server";
import type { Authz } from "@/lib/authz";
import { isUuid } from "@/lib/list-params";
import { listBillingRequests } from "@/lib/billing-requests";
import {
  createProjectBillingRequest,
  BillingRequestAmountError,
} from "@/lib/billing-request-actions";
import { notFound } from "@/lib/api/responses";
import { projectBillingRequestBody } from "@/lib/billing-request-schemas";

export const runtime = "nodejs";

async function getBillingRequests(gate: Authz, req: Request) {
  const projectId = new URL(req.url).searchParams.get("projectId");
  if (!projectId || !isUuid(projectId))
    return NextResponse.json({ error: "projectId required" }, { status: 400 });
  const requests = await listBillingRequests(gate.user.orgId, projectId, gate.allowedSubsidiaryIds);
  return NextResponse.json({ requests });
}

export const GET = defineRoute({
  permission: "projects.read",
  feature: "projects",
  handler: async ({ request, authz }) => getBillingRequests(authz, request),
});

export const POST = defineRoute({
  permission: "projects.manage",
  feature: "projects",
  body: projectBillingRequestBody,
  handler: async ({ body, authz: gate }) => {
    const projectId = String(body?.projectId ?? "");
    if (!body?.projectId || !isUuid(projectId)) {
      return NextResponse.json({ error: "projectId required" }, { status: 400 });
    }
    try {
      const created = await createProjectBillingRequest(
        gate.user.orgId,
        gate.user.id,
        { ...body, projectId },
        gate.allowedSubsidiaryIds,
      );
      return NextResponse.json(created);
    } catch (e) {
      if (e instanceof BillingRequestAmountError) {
        return NextResponse.json({ error: e.message }, { status: e.status });
      }
      if ((e as Error).message === "Project not found") {
        return notFound("record");
      }
      return apiErrorResponse(e);
    }
  },
});
