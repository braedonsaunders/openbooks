import { NextResponse } from "next/server";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { db } from "@openbooks/engine/platform/db";
import {
  fulfillmentDocumentScope,
  releasePickList,
} from "@openbooks/engine/sales/fulfillment/module";
import { notFound } from "@/lib/api/responses";
import { defineRoute } from "@/lib/api/route";
import { guardSubsidiaryScope } from "@/lib/authz";

/**
 * Release a draft pick list through Flows: an approval gate lands it in
 * pending approval, otherwise it is released and holds its bins. Refused by
 * name when a bin no longer covers its lines.
 */
export const POST = defineRoute({
  permission: "orders.fulfill",
  feature: "fulfillment",
  params: z.object({ id: uuidString() }),
  handler: async ({ authz, params: { id } }) => {
    const orgId = authz.user.orgId;
    const pickList = await fulfillmentDocumentScope(db, orgId, id, "pick_list");
    if (!pickList || guardSubsidiaryScope(authz, pickList.subsidiaryId))
      return notFound("pick_list", id);
    const released = await releasePickList(orgId, authz.user.id, {
      pickListId: id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    });
    return NextResponse.json({ pickList: released });
  },
});
