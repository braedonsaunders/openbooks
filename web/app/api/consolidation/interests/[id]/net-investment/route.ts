import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import {
  loadNetInvestmentOptions,
  proposeNetInvestmentAssessment,
} from "@openbooks/engine/consolidation";
const schema = z
  .object({
    pairId: uuidString(),
    bookId: uuidString(),
    eliminationSubsidiaryId: uuidString(),
    ociAccountId: uuidString(),
    profitLossAccountId: uuidString(),
    sourceLineIds: z.array(uuidString()).min(1).max(200),
    notPlannedOrLikely: z.literal(true),
    nonTrade: z.literal(true),
    qualificationEvidence: z.string().trim().min(40).max(10000),
    effectiveOn: z.string(),
    reason: z.string().trim().min(8).max(1000),
    idempotencyKey: z.string().min(1).max(120),
  })
  .strict();
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
