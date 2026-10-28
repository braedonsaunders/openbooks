import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { bulkBuyBody, buyBulkShipmentLabels } from "@/lib/shipping/bulk";

/** Buy each previewed label independently and merge downloaded PDFs when available. */
export const POST = defineRoute({
  permission: "shipping.manage",
  feature: "shippingHub",
  body: bulkBuyBody,
  handler: async ({ authz, body }) => {
    const result = await buyBulkShipmentLabels(
      authz.user.orgId,
      authz.user.id,
      authz.allowedSubsidiaryIds,
      body,
    );
    return NextResponse.json(result);
  },
});
