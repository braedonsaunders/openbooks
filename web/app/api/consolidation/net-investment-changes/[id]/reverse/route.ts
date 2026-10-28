import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { proposeNetInvestmentReversal } from "@openbooks/engine/consolidation";
import { netInvestmentReversalSchema as reversalBodySchema } from "@/lib/consolidation/action-schemas";

export const POST = defineRoute({
  permission: "close.run",
  feature: {
    none: "Correcting posted OCI remains available when its creation features are disabled.",
  },
  params: z.object({ id: uuidString() }),
  body: reversalBodySchema,
  invalidBodyStatus: 422,
  handler: async ({ body, authz, params }) => {
    try {
      return NextResponse.json({
        changeId: await proposeNetInvestmentReversal(
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
