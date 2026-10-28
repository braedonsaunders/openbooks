import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import {
  loadNetInvestmentOptions,
  proposeNetInvestmentAssessment,
} from "@openbooks/engine/consolidation";
import { netInvestmentAssessmentSchema as schema } from "@/lib/consolidation/action-schemas";
const params = z.object({ id: uuidString() });
export const GET = defineRoute({
  permission: "close.run",
  feature: "multiSubsidiary",
  params,
  handler: async ({ authz, params }) => {
    try {
      return NextResponse.json(
        await loadNetInvestmentOptions(authz.user.orgId, params.id, authz.user.id),
      );
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
});
export const POST = defineRoute({
  permission: "close.run",
  feature: "multiSubsidiary",
  params,
  body: schema,
  invalidBodyStatus: 422,
  handler: async ({ body, authz, params }) => {
    try {
      return NextResponse.json({
        changeId: await proposeNetInvestmentAssessment(
          authz.user.orgId,
          params.id,
          authz.user.id,
          body,
        ),
      });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
});
