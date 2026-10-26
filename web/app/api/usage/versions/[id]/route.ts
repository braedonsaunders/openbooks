import { getUsageRatingPlanVersionWithBands } from "@openbooks/engine/billing/usage/rating-plans";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";

export const GET = defineRoute({
  permission: "usage.read",
  feature: "usageBilling",
  params: z.object({ id: uuidString() }).strict(),
  handler: async ({ authz, params }) =>
    Response.json(await getUsageRatingPlanVersionWithBands(authz.user.orgId, params.id)),
});
