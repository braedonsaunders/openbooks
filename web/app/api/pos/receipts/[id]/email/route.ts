import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { uuidId } from "@/lib/api/json";
import { emailPosReceipt } from "@/lib/pos";

export const runtime = "nodejs";

/** POST /api/pos/receipts/[id]/email — email the receipt through the organization's email delivery. */
export const POST = defineRoute({
  permission: "pos.sell",
  feature: "posRegister",
  params: z.object({ id: uuidId }),
  invalidParamsNotFound: "record",
  // Null sends to the email recorded on the sale's customer.
  body: z.object({ to: z.string().trim().max(320).nullable() }).strict(),
  handler: async ({ authz, params, body }) => {
    try {
      const sent = await emailPosReceipt({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        documentId: params.id,
        to: body.to ?? null,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds ?? null,
      });
      return NextResponse.json(sent);
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
});
