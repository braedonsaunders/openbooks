import { jsonObject, makeGET, makePATCH, makeDELETE } from "../../_order/handlers";
import { defineRoute } from "@/lib/api/route";
import { isUuid } from "@/lib/list-params";
import { z } from "zod";

export const runtime = "nodejs";

const cfg = { kind: "sales_order", readPerm: "ar.read", createPerm: "ar.create" } as const;

const get = makeGET(cfg);
const patch = makePATCH(cfg);
const remove = makeDELETE(cfg);
const params = z.object({ id: z.string().refine(isUuid) });

export const GET = defineRoute({
  permission: "ar.read",
  feature: "orders",
  params,
  invalidParamsNotFound: "record",
  handler: ({ request, params, authz }) => get(request, { params: Promise.resolve(params) }, authz),
});
export const PATCH = defineRoute({
  permission: "ar.create",
  feature: "orders",
  params,
  invalidParamsNotFound: "record",
  body: jsonObject,
  handler: ({ request, params, authz, body }) =>
    patch(request, { params: Promise.resolve(params) }, authz, body),
});
export const DELETE = defineRoute({
  permission: "ar.create",
  feature: "orders",
  params,
  invalidParamsNotFound: "record",
  handler: ({ request, params, authz }) =>
    remove(request, { params: Promise.resolve(params) }, authz),
});
