import { NextResponse } from "next/server";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { notFound } from "@/lib/api/responses";
import { defineRoute } from "@/lib/api/route";
import { assertCan, guardSubsidiaryScope } from "@/lib/authz";
import { findReturnAuthorization, inspectReturnAuthorization } from "@/lib/returns";

const bodySchema = z.object({
  lines: z
    .array(
      z.object({
        lineId: uuidString(),
        accepted: z.string().max(40),
        disposition: z.enum(["restock", "scrap", "vendor-return"]).nullable(),
        dispositionLocationId: uuidString().nullable(),
        vendorId: uuidString().nullable().optional(),
      }),
    )
    .min(1)
    .max(500),
  waiveFee: z.boolean().optional(),
  waiveReason: z.string().max(500).nullable().optional(),
});

export const POST = defineRoute({
  permission: "ar.create",
  feature: "returnAuthorizations",
  params: z.object({ id: uuidString() }),
  body: bodySchema,
  handler: async ({ authz, params: { id }, body }) => {
    assertCan(authz, "items.post");
    if (body.waiveFee === true) assertCan(authz, "returns.waive_fee");
    const current = await findReturnAuthorization(authz.user.orgId, id, authz.allowedSubsidiaryIds);
    if (!current || guardSubsidiaryScope(authz, current.subsidiaryId))
      return notFound("return_authorization", id);
    const result = await inspectReturnAuthorization({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      documentId: id,
      inspectionLines: body.lines,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      waiveFee: body.waiveFee,
      waiveReason: body.waiveReason ?? null,
    });
    return NextResponse.json(result);
  },
});
