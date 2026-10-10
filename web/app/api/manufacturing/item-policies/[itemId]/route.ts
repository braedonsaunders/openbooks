import { z } from "zod";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { getItemPolicy, upsertItemPolicy, type ItemPolicyInput } from "@openbooks/engine/src/manufacturing/item-policies.ts";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { manufacturingTransaction } from "../../_transaction";

const Params = z.object({ itemId: z.string().uuid() });
const Body = z.object({
  supplyMethod: z.enum(["make", "buy", "transfer"]), leadTimeDays: z.number().int().nonnegative().nullable(),
  safetyStockQty: z.string(), minimumQty: z.string(), orderMultipleQty: z.string(), scrapPctPlanned: z.string(),
});

export const GET = defineRoute({
  permission: "manufacturing.read", feature: "manufacturing", params: Params,
  handler: async ({ authz, params }) => manufacturingTransaction(authz.user.orgId, async () => {
    return Response.json(await getItemPolicy(db, authz.user.orgId, params.itemId));
  }),
});

export const PUT = defineRoute({
  permission: "manufacturing.manage", feature: "manufacturing", params: Params, body: Body, scope: "unrestricted",
  handler: async ({ authz, params, body }) => manufacturingTransaction(authz.user.orgId, async () => {
    try {
      return Response.json(await upsertItemPolicy(db, authz.user.orgId, authz.user.id, params.itemId, body as ItemPolicyInput));
    } catch (error) {
      if ((error as { status?: number }).status === 404) return notFound("item planning policy");
      throw error;
    }
  }),
});
