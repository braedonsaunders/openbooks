import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { rebateBody, runRebateAction } from "@/lib/rebate-actions";

export const POST = defineRoute({
  permission: "documents.read",
  feature: "rebateManagement",
  body: rebateBody,
  handler: async ({ authz, body }) => {
    try {
      return NextResponse.json(await runRebateAction(authz.user.orgId, authz.user.id, body));
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
});
