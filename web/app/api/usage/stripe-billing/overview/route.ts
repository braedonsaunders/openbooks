import { getStripeBillingOverview } from "@openbooks/engine/src/sync/stripe-billing.ts";
import { defineRoute } from "@/lib/api/route";

export const GET = defineRoute({
  permission: "usage.read",
  feature: "usageBilling",
  handler: async ({ authz }) => Response.json(await getStripeBillingOverview(authz.user.orgId)),
});
