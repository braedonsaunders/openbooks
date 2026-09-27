import { closeSubscriptionUsageLink } from "@openbooks/engine/src/billing/usage/rating-plans.ts";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";

const Params = z.object({ id: z.string().uuid() }).strict();
const Body = z.object({ effectiveTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict();

export const POST = defineRoute({
  permission: "usage.manage",
  feature: "usageBilling",
  params: Params,
  body: Body,
  handler: async ({ authz, params, body }) => Response.json(await closeSubscriptionUsageLink(
    authz.user.orgId,
    authz.user.id,
    params.id,
    body.effectiveTo,
    authz.allowedSubsidiaryIds,
  )),
});
