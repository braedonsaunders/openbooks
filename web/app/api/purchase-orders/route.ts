import { orderCreateBody } from "@/lib/api/json";
import { defineRoute } from "@/lib/api/route";
import { guardPermission } from "@/lib/authz";
import { createOrder } from "../_order/create";

export const runtime = "nodejs";

/**
 * Unsaved-create collection: the purchase-order drawer opens and cancels
 * with zero writes; its explicit Save persists here exactly once
 * (idempotent, audited, status=draft). The body parses through the typed
 * order-create boundary before the kernel sees it.
 */
export const POST = defineRoute({
  authorize: () => guardPermission("purchase_orders.create"),
  feature: "orders",
  body: orderCreateBody,
  handler: async ({ request, authz, body }) =>
    createOrder(
      { kind: "purchase_order", createPerm: "purchase_orders.create", numberPrefix: "PO-" },
      authz,
      request,
      body,
    ),
});
