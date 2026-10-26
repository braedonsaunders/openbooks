import { deactivateUsageMeter } from "@openbooks/engine/billing/usage/records";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";

export const POST = defineRoute({
  permission: "usage.manage",
  feature: "usageBilling",
  scope: "unrestricted",
  params: z.object({ id: uuidString() }).strict(),
  handler: async ({ authz, params }) =>
    Response.json(await deactivateUsageMeter(authz.user.orgId, authz.user.id, params.id)),
});
