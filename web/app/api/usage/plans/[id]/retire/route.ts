import { retireUsageRatingPlan } from "@openbooks/engine/billing/usage/rating-plans";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";

export const POST = defineRoute({
  permission: "usage.manage",
  feature: "usageBilling",
  scope: "unrestricted",
  params: z.object({ id: uuidString() }).strict(),
  handler: async ({ authz, params }) =>
    Response.json(await retireUsageRatingPlan(authz.user.orgId, authz.user.id, params.id)),
});
