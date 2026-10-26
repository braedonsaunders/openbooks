import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { controlRecognition } from "@openbooks/engine/revenue/recognition-controls";
import { isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
export const POST = defineRoute({
  permission: "ar.post",
  feature: "revenueRecognition",
  params: z.object({ id: uuidString() }),
  body: z.object({
    action: z.enum(["hold", "release", "deliver"]),
    reason: z.string().trim().min(8).max(1000),
    expectedRevision: z.number().int().positive(),
    effectiveOn: z.string().refine(isIsoCalendarDate).optional(),
    evidence: z.string().trim().min(8).max(4000).optional(),
  }),
  handler: async ({ authz, params, body }) => {
    try {
      return NextResponse.json(
        await controlRecognition(authz.user.orgId, authz.user.id, params.id, body),
      );
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
});
