import { makeGET, makePATCH, makeDELETE } from "../../_order/handlers";
import { defineRoute } from "@/lib/api/route";
import { guardPermission } from "@/lib/authz";
import { z } from "zod";

export const runtime = "nodejs";

const cfg = {
  kind: "purchase_order",
  readPerm: "purchase_orders.read",
  createPerm: "purchase_orders.create",
} as const;

const getOrder = makeGET(cfg);
const patchOrder = makePATCH(cfg);
const deleteOrder = makeDELETE(cfg);
const orderParams = z.object({ id: z.string() });

export const GET = defineRoute({
  authorize: () => guardPermission(cfg.readPerm),
  feature: "orders",
  params: orderParams,
  handler: async ({ request, params }) => getOrder(request, { params: Promise.resolve(params) }),
});
export const PATCH = defineRoute({
  authorize: () => guardPermission(cfg.createPerm),
  feature: "orders",
  params: orderParams,
  handler: async ({ request, params }) => patchOrder(request, { params: Promise.resolve(params) }),
});
export const DELETE = defineRoute({
  authorize: () => guardPermission(cfg.createPerm),
  feature: "orders",
  params: orderParams,
  handler: async ({ request, params }) => deleteOrder(request, { params: Promise.resolve(params) }),
});
