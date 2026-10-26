import { defineRoute } from "@/lib/api/route";
import "next/server";
import { orderCreateBody } from "@/lib/api/json";
import { createOrder } from "../_order/create";

export const runtime = "nodejs";

/**
 * Unsaved-create collection: the Estimates drawer opens and cancels with
 * zero writes; its explicit Save persists here exactly once (idempotent,
 * audited, status=draft). The body parses through the typed order-create
 * boundary before the kernel sees it.
 */
export const POST = defineRoute({
  permission: "estimates.create",
  feature: "orders",
  body: orderCreateBody,
  handler: async ({ request: req, authz: gate, body }) => {
    return createOrder(
      { kind: "quote", createPerm: "estimates.create", numberPrefix: "EST-" },
      gate,
      req,
      body,
    );
  },
});
