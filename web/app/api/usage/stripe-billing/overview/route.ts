import { getStripeBillingOverview } from "@openbooks/engine/sync";
import { defineRoute } from "@/lib/api/route";

export const GET = defineRoute({
  permission: "usage.read",
  feature: "usageBilling",
  handler: async ({ authz }) => Response.json(await getStripeBillingOverview(authz.user.orgId)),
});
