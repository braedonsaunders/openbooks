import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { authorizeChange } from "@/app/api/accounting/changes/_authorization";
import { parseJsonBody } from "@/lib/api/json";
import { proposeLossOfControlReversal } from "@openbooks/engine/consolidation/loss-of-control";
import { lossOfControlReversalSchema } from "@/lib/consolidation/action-schemas";
export const POST = defineRoute({
  permission: "close.run",
  feature: "multiSubsidiary",
  handler: async ({ request: req, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const { id } = await params,
      gate = await authorizeChange(id);
    if (gate instanceof NextResponse) return gate;
    if (gate.domain !== "consolidation")
      return NextResponse.json({ error: "select a consolidation change" }, { status: 422 });
    const body = await parseJsonBody(req, lossOfControlReversalSchema, { status: 422 });
    if (!body.ok) return body.response;
    try {
      return NextResponse.json({
        changeId: await proposeLossOfControlReversal(
          gate.auth.user.orgId,
          id,
          gate.auth.user.id,
          body.data.reason,
          body.data.idempotencyKey,
        ),
      });
    } catch (e) {
      return apiErrorResponse(e);
    }
  },
});
