import { jsonObject, makeConvertPOST } from "../../../_order/handlers";
import { guardFeaturePermission } from "@/lib/feature-gates";
import { NextResponse } from "next/server";
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

export const POST = defineRoute({
  authorize: async ({ params }) => {
    const gate = await guardFeaturePermission(PURCHASE_ORDER_PERMISSIONS.read, "orders");
    if (gate instanceof NextResponse) return gate;
    const id = (params as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string" || !isUuid(id)) return notFound("record");
    if (await conversionWouldCopyInventoryKinds(gate.user.orgId, id)) return notFound("record");
    return gate;
  },
  feature: "orders",
  params: z.object({ id: z.string().refine(isUuid) }),
  invalidParamsNotFound: "record",
  body: jsonObject,
  handler: async ({ request, params, authz, body }) =>
    convert(request, { params: Promise.resolve(params) }, authz, body),
});
