import { getUsageRatingPlanVersionWithBands } from "@openbooks/engine/src/billing/usage/rating-plans.ts";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";

export const GET = defineRoute({
  permission: "usage.read",
  feature: "usageBilling",
  params: z.object({ id: z.string().uuid() }).strict(),
  handler: async ({ authz, params }) => Response.json(await getUsageRatingPlanVersionWithBands(authz.user.orgId, params.id)),
});
