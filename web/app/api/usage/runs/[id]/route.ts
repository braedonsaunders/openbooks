import { getRateRun } from "@openbooks/engine/billing/usage/rate-run";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";

export const GET = defineRoute({
  permission: "usage.read",
  feature: "usageBilling",
  params: z.object({ id: z.string().uuid() }).strict(),
  handler: async ({ authz, params }) => Response.json(await getRateRun(authz.user.orgId, params.id, authz.allowedSubsidiaryIds)),
});
