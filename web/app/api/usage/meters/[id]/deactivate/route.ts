import { deactivateUsageMeter } from "@openbooks/engine/src/billing/usage/records.ts";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";

export const POST = defineRoute({
  permission: "usage.manage",
  feature: "usageBilling",
  scope: "unrestricted",
  params: z.object({ id: z.string().uuid() }).strict(),
  handler: async ({ authz, params }) => Response.json(await deactivateUsageMeter(authz.user.orgId, authz.user.id, params.id)),
});
