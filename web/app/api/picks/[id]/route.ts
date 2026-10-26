import { NextResponse } from "next/server";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { db } from "@openbooks/engine/platform/db";
import { getFulfillmentDocument } from "@openbooks/engine/sales/fulfillment/module";
import { notFound } from "@/lib/api/responses";
import { defineRoute } from "@/lib/api/route";

/** One pick list with its lines; out of scope answers like an absent one. */
export const GET = defineRoute({
  permission: "orders.fulfill",
  feature: "fulfillment",
  params: z.object({ id: uuidString() }),
  handler: async ({ authz, params: { id } }) => {
    const pickList = await getFulfillmentDocument(
      db,
      authz.user.orgId,
      id,
      authz.allowedSubsidiaryIds,
    );
    if (!pickList || pickList.kind !== "pick_list") return notFound("pick_list", id);
    return NextResponse.json({ pickList });
  },
});
