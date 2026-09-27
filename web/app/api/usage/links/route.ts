import { createSubscriptionUsageLink, listSubscriptionUsageLinks } from "@openbooks/engine/src/billing/usage/rating-plans.ts";
import { defineRoute } from "@/lib/api/route";
import { idempotentUsageCreate } from "../_idempotent";
import { z } from "zod";

const Query = z.object({ subscriptionId: z.string().uuid().optional(), customerId: z.string().uuid().optional() }).strict();
const Body = z.object({
  subscriptionId: z.string().uuid(),
  customerId: z.string().uuid(),
  planVersionId: z.string().uuid(),
  meterIds: z.array(z.string().uuid()).min(1).max(500),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effectiveTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  commitAmount: z.string().nullable().optional(),
  commitPeriod: z.enum(["monthly", "annual"]).nullable().optional(),
  allowOverage: z.boolean().optional(),
}).strict();

export const GET = defineRoute({
  permission: "usage.read",
  feature: "usageBilling",
  handler: async ({ request, authz }) => {
    const parsed = Query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success || (parsed.data.subscriptionId === undefined) === (parsed.data.customerId === undefined)) {
      return Response.json({ error: "Supply exactly one subscriptionId or customerId filter" }, { status: 400 });
    }
    return Response.json(await listSubscriptionUsageLinks(authz.user.orgId, parsed.data, authz.allowedSubsidiaryIds));
  },
});

export const POST = defineRoute({
  permission: "usage.manage",
  feature: "usageBilling",
  body: Body,
  handler: async ({ request, authz, body }) => idempotentUsageCreate({
    request, authz, operation: "usage.link.create", requestBody: body,
    execute: () => createSubscriptionUsageLink(authz.user.orgId, authz.user.id, body, authz.allowedSubsidiaryIds),
  }),
});
