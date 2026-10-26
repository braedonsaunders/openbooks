import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { proposeNetInvestmentReversal } from "@openbooks/engine/consolidation";
const reversalBodySchema = z
  .object({
    effectiveOn: z.string(),
    reason: z.string().trim().min(8).max(1000),
    idempotencyKey: z.string().min(1).max(120),
  })
  .strict();

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
