import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { guardFeaturePermission } from "@/lib/feature-gates";
import { makeConvertPOST } from "../../../_order/handlers";
import { jsonObject } from "@/lib/api/json";
import { isUuid } from "@/lib/list-params";
import { conversionWouldCopyInventoryKinds } from "@/lib/order-cycle";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

const convert = makeConvertPOST({
  kind: "sales_order",
  readPerm: "ar.read",
  createPerm: "ar.create",
});

export const POST = defineRoute({
  authorize: async ({ params }) => {
    const gate = await guardFeaturePermission("ar.create", "orders");
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
  handler: ({ request, params, authz, body }) =>
    convert(authz, request, { params: Promise.resolve(params) }, body),
});
