import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { applicationContextFromSession } from "@/lib/application/context";
import { guardSubsidiaryScope } from "@/lib/authz";
import { created, notFound } from "@/lib/api/responses";
import { defineRoute } from "@/lib/api/route";
import { createDropShipPurchaseOrder, dropShipRecordScope } from "@/lib/drop-ship";

export const POST = defineRoute({
  permission: "ap.create",
  feature: "dropShipping",
  params: z.object({ id: uuidString() }),
  body: z.object({ vendorId: uuidString() }).strict(),
  handler: async ({ request, authz, params, body }) => {
    const scope = await dropShipRecordScope(authz.user.orgId, params.id, "sales_order");
    if (!scope || guardSubsidiaryScope(authz, scope.subsidiaryId)) return notFound("record");
    const key = request.headers.get("Idempotency-Key")?.trim() ?? "";
    const context = applicationContextFromSession(
      authz,
      "api",
      request.headers.get("x-request-id") ?? key,
    );
    return created(
      await createDropShipPurchaseOrder(context, {
        salesOrderId: params.id,
        vendorId: body.vendorId,
        idempotencyKey: key,
      }),
    );
  },
});
