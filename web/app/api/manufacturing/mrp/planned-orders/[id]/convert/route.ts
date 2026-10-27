import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { getPlannedOrder } from "@openbooks/engine/manufacturing/mrp";
import { db } from "@openbooks/engine/platform/db";
import { can, guardSubsidiaryScope } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { manufacturingTransaction } from "../../../../_transaction";
import { convertManufacturingPlannedOrder } from "@/lib/manufacturing/planned-order-conversion";

const Params = z.object({ id: uuidString() });
// Make suggestions derive their work order from the saved plan. Buy and
// transfer suggestions still require their vendor or locations in the service.
const Body = z.union(
  [
    z
      .object({})
      .strict()
      .transform(() => ({
        fromLocationId: undefined,
        toLocationId: undefined,
        vendorId: undefined,
      })),
    z
      .object({
        vendorId: uuidString(),
        fromLocationId: uuidString().optional(),
        toLocationId: uuidString().optional(),
      })
      .strict(),
    z
      .object({
        fromLocationId: uuidString(),
        toLocationId: uuidString().optional(),
        vendorId: uuidString().optional(),
      })
      .strict(),
    z
      .object({
        toLocationId: uuidString(),
        fromLocationId: uuidString().optional(),
        vendorId: uuidString().optional(),
      })
      .strict(),
  ],
  { error: "Send an empty object for the saved plan, or valid location/vendor identifiers." },
);

export const POST = defineRoute({
  permission: "manufacturing.manage",
  feature: "manufacturingMrp",
  params: Params,
  body: Body,
  invalidBodyStatus: 422,
  handler: async ({ authz, params, body }) =>
    manufacturingTransaction(authz.user.orgId, async () => {
      const suggestion = await getPlannedOrder(db, authz.user.orgId, params.id, authz.user.id);
      const denied = guardSubsidiaryScope(authz, suggestion.subsidiaryId);
      if (denied) return denied;
      if (suggestion.action === "buy" && !can(authz, "purchase_orders.create")) {
        return Response.json(
          {
            error: "forbidden",
            permission: "purchase_orders.create",
            message: "Missing required grant: purchase_orders.create.",
          },
          { status: 403 },
        );
      }
      const result = await convertManufacturingPlannedOrder(authz, params.id, body);
      return Response.json(result, { status: result.replayed ? 200 : 201 });
    }),
});
