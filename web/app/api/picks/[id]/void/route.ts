import { NextResponse } from "next/server";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { db } from "@openbooks/engine/platform/db";
import { fulfillmentDocumentScope, voidPickList } from "@openbooks/engine/sales/fulfillment/module";
import { notFound } from "@/lib/api/responses";
import { defineRoute } from "@/lib/api/route";
import { guardSubsidiaryScope } from "@/lib/authz";

/** Void a pick list before completion, with a reason; it stops holding its bins. */
export const POST = defineRoute({
  permission: "orders.fulfill",
  feature: "fulfillment",
  params: z.object({ id: uuidString() }),
  body: z.object({ reason: z.string().max(1000) }),
  handler: async ({ authz, params: { id }, body }) => {
    const orgId = authz.user.orgId;
    const pickList = await fulfillmentDocumentScope(db, orgId, id, "pick_list");
    if (!pickList || guardSubsidiaryScope(authz, pickList.subsidiaryId))
      return notFound("pick_list", id);
    await db.transaction((tx) =>
      voidPickList(tx, orgId, authz.user.id, {
        pickListId: id,
        reason: body.reason,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      }),
    );
    return NextResponse.json({ id, status: "voided" });
  },
});
