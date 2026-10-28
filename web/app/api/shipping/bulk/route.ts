import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import {
  bulkPreviewBody,
  listBulkShipmentCandidates,
  previewBulkShipmentLabels,
} from "@/lib/shipping/bulk";

/** Draft, open shipments without a purchased label, for the bulk buyer. */
export const GET = defineRoute({
  permission: "orders.fulfill",
  feature: "shippingHub",
  handler: async ({ authz }) => {
    const candidates = await listBulkShipmentCandidates(
      authz.user.orgId,
      authz.allowedSubsidiaryIds,
    );
    return NextResponse.json({ candidates });
  },
});

/** Preview one rate per parcel and retain a refusal row for every unrated parcel. */
export const POST = defineRoute({
  permission: "orders.fulfill",
  feature: "shippingHub",
  body: bulkPreviewBody,
  handler: async ({ authz, body }) => {
    const result = await previewBulkShipmentLabels(
      authz.user.orgId,
      authz.user.id,
      authz.allowedSubsidiaryIds,
      body,
    );
    return NextResponse.json(result);
  },
});
