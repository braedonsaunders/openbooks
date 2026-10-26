import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { generateRenewalDocument, acceptRenewalDocument } from "@openbooks/engine/billing/renewals";
import { isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
export const POST = defineRoute({
  permission: "ar.create",
  feature: "advancedSubscriptions",
  body: z.discriminatedUnion("action", [
    z
      .object({
        action: z.literal("generate"),
        subscriptionId: uuidString(),
        asOf: z.string().refine(isIsoCalendarDate),
      })
      .strict(),
    z
      .object({
        action: z.literal("accept"),
        documentId: uuidString(),
        reason: z.string().trim().min(8).max(2000),
      })
      .strict(),
  ]),
  handler: async ({ authz, body }) => {
    try {
      return NextResponse.json(
        body.action === "generate"
          ? await generateRenewalDocument(
              authz.user.orgId,
              authz.user.id,
              body.subscriptionId,
              body.asOf,
            )
          : await acceptRenewalDocument(
              authz.user.orgId,
              authz.user.id,
              body.documentId,
              body.reason,
            ),
      );
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
});
