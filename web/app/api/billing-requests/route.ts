import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from '@/lib/api/error-response'
import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { normalizeMoney } from "@openbooks/engine/src/money/money.ts";
import { guardPermission } from "../../../lib/authz";
import { isUuid } from "../../../lib/list-params";
import {
  createBillingRequest,
  listBillingRequests,
} from "../../../lib/billing-requests";
import { canonicalDecimal } from "../../../lib/exact-decimal";
import { moneyRefusal } from "../../../lib/payroll-decimal-refusal";
import { guardProjectsFeature } from "../../../lib/projects-gate";
import { notFound } from "@/lib/api/responses";

const requestBodySchema = z.object({
  projectId: z.string().uuid(),
  drawAmount: z.string().superRefine((value, ctx) => {
    if (value !== "" && canonicalDecimal(value, 4) === null) {
      ctx.addIssue({ code: "custom", message: moneyRefusal("Draw amount", value) });
    }
  }).nullable().optional(),
});



export const runtime = "nodejs";

async function legacyGET(req: Request) {
  const gate = await guardPermission("projects.read");
  if (gate instanceof NextResponse) return gate;
  const feature = await guardProjectsFeature(gate.user.orgId);
  if (feature) return feature;
  const projectId = new URL(req.url).searchParams.get("projectId");
  if (!projectId || !isUuid(projectId))
    return NextResponse.json({ error: "projectId required" }, { status: 400 });
  const requests = await listBillingRequests(
    gate.user.orgId,
    projectId,
    gate.allowedSubsidiaryIds,
  );
  return NextResponse.json({ requests });
}

async function legacyPOST(req: Request) {
  const gate = await guardPermission("projects.manage");
  if (gate instanceof NextResponse) return gate;
  const feature = await guardProjectsFeature(gate.user.orgId);
  if (feature) return feature;
  const parsedBody = await parseJsonBody(req, requestBodySchema);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  const projectId = String(body?.projectId ?? "");
  if (!body?.projectId || !isUuid(projectId)) {
    return NextResponse.json({ error: "projectId required" }, { status: 400 });
  }
  let drawAmount: string | null = null;
  if (body.drawAmount != null && body.drawAmount !== "") {
    const exact = canonicalDecimal(body.drawAmount, 4);
    if (exact === null) {
      return NextResponse.json(
        { error: moneyRefusal("Draw amount", body.drawAmount) },
        { status: 422 },
      );
    }
    try {
      drawAmount = normalizeMoney(exact);
    } catch {
      return NextResponse.json(
        { error: moneyRefusal("Draw amount", body.drawAmount) },
        { status: 422 },
      );
    }
  }
  try {
    const created = await createBillingRequest(
      gate.user.orgId,
      gate.user.id,
      {
        ...body,
        projectId,
        drawAmount,
      },
      gate.allowedSubsidiaryIds,
    );
    return NextResponse.json(created);
  } catch (e) {
    if ((e as Error).message === "Project not found") {
      return notFound("record");
    }
    return apiErrorResponse(e);
  }
}

export const GET = defineRoute({
  permission: "projects.read",
  feature: { none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks." },
  handler: async ({ request }) => legacyGET(request as never),
});

export const POST = defineRoute({
  permission: "projects.manage",
  feature: { none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks." },
  body: requestBodySchema,
  handler: async ({ request, body }) => {
    const replayHeaders = new Headers(request.headers);
    replayHeaders.delete("content-length");
    const replayRequest = new Request(request.url, { method: request.method, headers: replayHeaders, body: JSON.stringify(body), signal: request.signal });
    return legacyPOST(replayRequest as never);
  },
});
