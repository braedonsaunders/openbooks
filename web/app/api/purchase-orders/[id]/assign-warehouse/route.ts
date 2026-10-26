import { makeAssignWarehousePOST } from "../../../_order/handlers";
import { defineRoute } from "@/lib/api/route";
import { guardPermission } from "@/lib/authz";
import { z } from "zod";

export const runtime = "nodejs";

const cfg = {
  kind: "purchase_order",
  readPerm: "purchase_orders.read",
  createPerm: "purchase_orders.create",
} as const;

const assignWarehouse = makeAssignWarehousePOST(cfg);
export const POST = defineRoute({
  authorize: () => guardPermission(cfg.createPerm),
  feature: "orders",
  params: z.object({ id: z.string() }),
  handler: async ({ request, params }) =>
    assignWarehouse(request, { params: Promise.resolve(params) }),
});
