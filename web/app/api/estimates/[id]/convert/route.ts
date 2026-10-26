import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { guardFeaturePermission } from "@/lib/feature-gates";
import { can } from "@/lib/authz";
import { jsonObject, makeConvertPOST } from "../../../_order/handlers";
import { isUuid } from "@/lib/list-params";
import { conversionWouldCopyInventoryKinds } from "@/lib/order-cycle";
import { estimateConversionPermission } from "@/lib/permissions";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

// Converting mints the downstream document under its own book's authority:
// a sales order or invoice still needs ar.create, so pricing estimates can
// never mint receivables on its own (estimateConversionPermission).
const convert = makeConvertPOST({
  kind: "quote",
  readPerm: "estimates.read",
  createPerm: "estimates.create",
  convertPerm: estimateConversionPermission,
});

export const POST = defineRoute({
  authorize: async ({ params }) => {
    const gate = await guardFeaturePermission("estimates.create", "orders");
    if (gate instanceof NextResponse) return gate;
    const id = (params as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string" || !isUuid(id)) return notFound("record");
    if (await conversionWouldCopyInventoryKinds(gate.user.orgId, id)) return notFound("record");
    if (!can(gate, "estimates.read")) {
      return NextResponse.json({ error: "missing permission: estimates.read" }, { status: 403 });
    }
    return gate;
  },
  feature: "orders",
  params: z.object({ id: z.string().refine(isUuid) }),
  invalidParamsNotFound: "record",
  body: jsonObject,
  handler: ({ request, params, authz, body }) =>
    convert(request, { params: Promise.resolve(params) }, authz, body),
});
