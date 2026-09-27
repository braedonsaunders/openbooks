import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from '@/lib/api/error-response'
import { guardCloseScope } from "@/lib/close-scope";

import { NextResponse } from "next/server";
import { attestOwnerManagedClose, requestCloseApproval } from "@openbooks/engine/src/close/approvals.ts";
import { closeApprovedRun, publishCloseRun } from "@openbooks/engine/src/close/run-completion.ts";
import { CloseError } from "@openbooks/engine/src/periods/period-policy.ts";
import { refreshCloseRun } from "@openbooks/engine/src/close/run-automation.ts";
import { guardFeaturePermission } from "../../../../../lib/feature-gates";
import { isFeatureEnabled } from "../../../../../lib/features";
import { isUuid } from "../../../../../lib/list-params";
import { notFound } from "@/lib/api/responses";

const requestBodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("refresh") }),
  z.object({ action: z.literal("request_approval") }),
  z.object({ action: z.literal("attest"), comment: z.string().max(2000).optional() }),
  z.object({ action: z.literal("close") }),
  z.object({ action: z.literal("publish"), comment: z.string().max(2000).optional() }),
]);



export const runtime = "nodejs";



export const POST = defineRoute({
  public: "session",
  params: z.object({ "id": z.string() }),
  body: requestBodySchema,
  handler: async ({ body, params }) => {

    const { id } = params;
    if (!isUuid(id))
      return NextResponse.json({ error: "invalid run id" }, { status: 400 });



    const permission =
      body.action === "close" || body.action === "attest"
        ? "close.approve"
        : "close.run";
    const gate = await guardFeaturePermission(permission, "continuousClose");
    if (gate instanceof NextResponse) return gate;
    const scopeDenied = guardCloseScope(gate);
    if (scopeDenied) return scopeDenied;
    if (body.action === "publish" && !(await isFeatureEnabled(gate.user.orgId, "advancedClose"))) {
      return notFound("record");
    }
    try {
      if (body.action === "refresh") {
        return NextResponse.json({
          ok: true,
          ...(await refreshCloseRun(gate.user.orgId, id, gate.user.id)),
        });
      }
      if (body.action === "request_approval")
        await requestCloseApproval(gate.user.orgId, id, gate.user.id);
      else if (body.action === "attest")
        await attestOwnerManagedClose(gate.user.orgId, id, gate.user.id, body.comment ?? "");
      else if (body.action === "close")
        await closeApprovedRun(gate.user.orgId, id, gate.user.id);
      else if (body.action === "publish")
        await publishCloseRun(gate.user.orgId, id, gate.user.id, body.comment);
      else
        return NextResponse.json(
          { error: "action must be refresh, request_approval, attest, close, or publish" },
          { status: 400 },
        );
      return NextResponse.json({ ok: true });
    } catch (error) {
      if (error instanceof CloseError)
        return apiErrorResponse(error, { safeStatus: 422 });
      throw error;
    }
  },
});
