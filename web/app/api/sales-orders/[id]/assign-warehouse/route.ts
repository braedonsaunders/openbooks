import { makeAssignWarehousePOST } from "../../../_order/handlers";
import { defineRoute } from "@/lib/api/route";
import { assignWarehouseBody } from "@/lib/api/json";
import { isUuid } from "@/lib/list-params";
import { z } from "zod";

export const runtime = "nodejs";

const cfg = { kind: "sales_order", readPerm: "ar.read", createPerm: "ar.create" } as const;

const assignWarehouse = makeAssignWarehousePOST(cfg);

export const POST = defineRoute({
  permission: "ar.create",
  feature: "orders",
  params: z.object({ id: z.string().refine(isUuid) }),
  invalidParamsNotFound: "record",
  body: assignWarehouseBody,
  handler: ({ request, params, authz, body }) =>
    assignWarehouse(request, { params: Promise.resolve(params) }, authz, body),
});
