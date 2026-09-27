import { z } from "zod";
import { applicationContextFromSession } from "@/lib/application/context";
import { guardSubsidiaryScope } from "@/lib/authz";
import { created, notFound } from "@/lib/api/responses";
import { defineRoute } from "@/lib/api/route";
import { confirmDropShip, dropShipRecordScope } from "@/lib/drop-ship";

export const POST = defineRoute({
  permission: "items.post",
  feature: "dropShipping",
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    confirmationDate: z.string().date().optional(),
    lines: z.array(z.object({ purchaseOrderLineId: z.string().uuid(), quantity: z.string().min(1).max(50) }).strict()).min(1),
  }).strict(),
  handler: async ({ request, authz, params, body }) => {
    const scope = await dropShipRecordScope(authz.user.orgId, params.id, "purchase_order");
    if (!scope || guardSubsidiaryScope(authz, scope.subsidiaryId)) return notFound("record");
    const key = request.headers.get("Idempotency-Key")?.trim() ?? "";
    const context = applicationContextFromSession(authz, "api", request.headers.get("x-request-id") ?? key);
    return created(await confirmDropShip(context, {
      purchaseOrderId: params.id,
      confirmationDate: body.confirmationDate,
      idempotencyKey: key,
      lines: body.lines,
    }));
  },
});
