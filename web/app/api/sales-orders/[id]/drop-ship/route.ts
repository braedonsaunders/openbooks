import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { applicationContextFromSession } from "@/lib/application/context";
import { guardSubsidiaryScope } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { dropShipRecordScope, routeSalesOrderLine } from "@/lib/drop-ship";

export const POST = defineRoute({
  permission: "orders.fulfill",
  feature: "dropShipping",
  params: z.object({ id: uuidString() }),
  body: z.object({ salesOrderLineId: uuidString(), routed: z.boolean() }).strict(),
  handler: async ({ request, authz, params, body }) => {
    const scope = await dropShipRecordScope(authz.user.orgId, params.id, "sales_order");
    if (!scope || guardSubsidiaryScope(authz, scope.subsidiaryId)) return notFound("record");
    const context = applicationContextFromSession(
      authz,
      "api",
      request.headers.get("x-request-id") ?? "drop-ship-route",
    );
    return Response.json(
      await routeSalesOrderLine(context, {
        salesOrderId: params.id,
        salesOrderLineId: body.salesOrderLineId,
        routed: body.routed,
      }),
    );
  },
});
