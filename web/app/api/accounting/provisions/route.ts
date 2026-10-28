import { NextResponse } from "next/server";
import { proposeProvisionAssessment } from "@openbooks/engine/provisions";
import { defineRoute, type PermissionRouteOptions } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { provisionAssessmentBodySchema } from "@/lib/provisions/assessment-schema";

export const runtime = "nodejs";
const options: PermissionRouteOptions<undefined, typeof provisionAssessmentBodySchema> = {
  permission: "gl.manage",
  feature: { none: "Provision assessment is a core general-ledger obligation control." },
  body: provisionAssessmentBodySchema,
  handler: async ({ authz, body }) => {
    try {
      return NextResponse.json(
        { id: await proposeProvisionAssessment(authz.user.orgId, authz.user.id, body) },
        { status: 201 },
      );
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
};
export const POST = defineRoute(options);
