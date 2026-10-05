import { skipStripeObject, unskipStripeObject } from "@openbooks/engine/src/sync/stripe-billing.ts";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";

const Body = z.object({
  objectType: z.enum(["customer", "subscription"]),
  stripeId: z.string().min(1).max(255),
  stripeAccount: z.string().min(1).max(255),
  reason: z.string().max(500).nullish(),
}).strict();

export const POST = defineRoute({
  permission: "usage.manage",
  feature: "usageBilling",
  body: Body,
  handler: async ({ authz, body }) => {
    await skipStripeObject(
      authz.user.orgId, authz.user.id, body.stripeAccount, body.objectType, body.stripeId, body.reason ?? null,
    );
    return Response.json({ ok: true });
  },
});

export const DELETE = defineRoute({
  permission: "usage.manage",
  feature: "usageBilling",
  body: Body,
  handler: async ({ authz, body }) => {
    await unskipStripeObject(authz.user.orgId, authz.user.id, body.stripeAccount, body.objectType, body.stripeId);
    return Response.json({ ok: true });
  },
});
