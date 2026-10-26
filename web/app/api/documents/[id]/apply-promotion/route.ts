import { NextResponse } from "next/server";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { applyDocumentPromotion } from "@/lib/promotions";

const bodySchema = z
  .object({
    code: z.string().max(64).optional(),
    promotionId: uuidString().optional(),
  })
  .refine((body) => Object.keys(body).length > 0 && (body.code || body.promotionId), {
    message: "A promotion code is required",
  });

export const POST = defineRoute({
  permission: "ar.create",
  feature: "promotions",
  params: z.object({ id: uuidString() }),
  body: bodySchema,
  handler: async ({ authz, params: { id }, body }) => {
    const result = await applyDocumentPromotion({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      documentId: id,
      code: body.code,
      promotionId: body.promotionId,
      channelId: null,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    });
    return NextResponse.json(result);
  },
});
