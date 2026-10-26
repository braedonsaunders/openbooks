import { makeGET, makePATCH, makeDELETE } from "../../_order/handlers";
import { defineRoute } from "@/lib/api/route";
import { jsonObject } from "@/lib/api/json";
import { isUuid } from "@/lib/list-params";
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
const orderParams = z.object({ id: z.string().refine(isUuid) });

export const GET = defineRoute({
  authorize: () => guardPermission(cfg.readPerm),
  feature: "orders",
  params: orderParams,
  invalidParamsNotFound: "record",
  handler: async ({ request, params, authz }) =>
    getOrder(request, { params: Promise.resolve(params) }, authz),
});
export const PATCH = defineRoute({
  authorize: () => guardPermission(cfg.createPerm),
  feature: "orders",
  params: orderParams,
  invalidParamsNotFound: "record",
  body: jsonObject,
  handler: async ({ request, params, authz, body }) =>
    patchOrder(request, { params: Promise.resolve(params) }, authz, body),
});
export const DELETE = defineRoute({
  authorize: () => guardPermission(cfg.createPerm),
  feature: "orders",
  params: orderParams,
  invalidParamsNotFound: "record",
  handler: async ({ request, params, authz }) =>
    deleteOrder(request, { params: Promise.resolve(params) }, authz),
});
