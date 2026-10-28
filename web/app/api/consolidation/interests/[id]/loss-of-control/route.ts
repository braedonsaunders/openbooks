import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/platform/db";
import {
  LossOfControlProposalError,
  loadLossOfControlProposalData,
  proposeLossOfControl,
} from "@openbooks/engine/consolidation/loss-of-control";
import { parseJsonBody } from "@/lib/api/json";
import { isUuid } from "@/lib/list-params";
import { lossOfControlSchema } from "@/lib/consolidation/action-schemas";
export const runtime = "nodejs";
export const GET = defineRoute({
  permission: "close.run",
  feature: "multiSubsidiary",
  handler: async ({ request: _req, authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { id } = await params;
    if (!isUuid(id))
      return NextResponse.json({ error: "invalid ownership interest" }, { status: 422 });
    const orgId = gate.user.orgId;
    try {
      return NextResponse.json(
        await loadLossOfControlProposalData(db, orgId, id, gate.allowedSubsidiaryIds),
      );
    } catch (e) {
      if (e instanceof LossOfControlProposalError) return apiErrorResponse(e);
      throw e;
    }
  },
});
export const POST = defineRoute({
  permission: "close.run",
  feature: "multiSubsidiary",
  handler: async ({ request: req, authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { id } = await params;
    if (!isUuid(id))
      return NextResponse.json({ error: "invalid ownership interest" }, { status: 422 });
    const body = await parseJsonBody(req, lossOfControlSchema, { status: 422 });
    if (!body.ok) return body.response;
    try {
      return NextResponse.json({
        changeId: await proposeLossOfControl(gate.user.orgId, id, gate.user.id, body.data),
      });
    } catch (e) {
      return apiErrorResponse(e);
    }
  },
});
