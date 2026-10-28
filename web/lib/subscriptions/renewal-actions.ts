import "server-only";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api/error-response";
import { generateRenewalDocument, acceptRenewalDocument } from "@openbooks/engine/billing/renewals";
import { isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
import type { Authz } from "@/lib/authz";

export const RenewalActionBody = z.discriminatedUnion("action", [
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
]);

export async function executeRenewalAction(
  authz: Authz,
  body: z.infer<typeof RenewalActionBody>,
): Promise<NextResponse> {
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
}
