import { makeConvertPOST } from "../../../_order/handlers";
import { guardPermission, type Authz } from "@/lib/authz";
import { isUuid } from "@/lib/list-params";
import { conversionWouldCopyInventoryKinds } from "@/lib/order-cycle";
import { notFound } from "@/lib/api/responses";
import { PURCHASE_ORDER_PERMISSIONS, purchaseOrderConversionPermission } from "@/lib/permissions";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";

export const runtime = "nodejs";

// Reading the order opens the endpoint; the conversion target decides the
// rest: receiving goods needs goods_receipts.create, billing needs ap.create.
const convert = makeConvertPOST({
  kind: "purchase_order",
  readPerm: PURCHASE_ORDER_PERMISSIONS.read,
  createPerm: PURCHASE_ORDER_PERMISSIONS.create,
  convertPerm: purchaseOrderConversionPermission,
});

async function convertPurchaseOrder(
  gate: Authz,
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  // A malformed id names no uuid document: refuse it before the
  // inventory-kind probe binds it to a uuid column (raw 500 when
  // Inventory is off), the same 404 the convert handler answers.
  if (!isUuid(id)) return notFound("record");
  if (await conversionWouldCopyInventoryKinds(gate.user.orgId, id)) {
    return notFound("record");
  }
  return convert(req, ctx);
}

export const POST = defineRoute({
  authorize: () => guardPermission(PURCHASE_ORDER_PERMISSIONS.read),
  feature: "orders",
  params: z.object({ id: z.string() }),
  handler: async ({ request, params, authz }) =>
    convertPurchaseOrder(authz, request, { params: Promise.resolve(params) }),
});
