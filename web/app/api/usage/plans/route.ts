import { createUsageRatingPlan, listUsageRatingPlans } from "@openbooks/engine/src/billing/usage/rating-plans.ts";
import { defineRoute } from "@/lib/api/route";
import { idempotentUsageCreate } from "../_idempotent";
import { z } from "zod";

const Body = z.object({ name: z.string().trim().min(1), currency: z.string().regex(/^[A-Z]{3}$/) }).strict();

export const GET = defineRoute({
  permission: "usage.read",
  feature: "usageBilling",
  handler: async ({ authz }) => Response.json(await listUsageRatingPlans(authz.user.orgId)),
});

export const POST = defineRoute({
  permission: "usage.manage",
  feature: "usageBilling",
  scope: "unrestricted",
  body: Body,
  handler: async ({ request, authz, body }) => idempotentUsageCreate({
    request, authz, operation: "usage.plan.create", requestBody: body,
    execute: () => createUsageRatingPlan(authz.user.orgId, authz.user.id, body),
  }),
});
