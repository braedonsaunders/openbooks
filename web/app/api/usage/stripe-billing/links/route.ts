import { linkStripeCustomer, linkStripeSubscription } from "@openbooks/engine/sync";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";

const Body = z.object({
  objectType: z.enum(["customer", "subscription"]),
  stripeId: z.string().min(1).max(255),
  nativeId: z.string().uuid(),
}).strict();

export const POST = defineRoute({
  permission: "usage.manage",
  feature: "usageBilling",
  body: Body,
  handler: async ({ authz, body }) => {
    if (body.objectType === "customer") {
      await linkStripeCustomer(authz.user.orgId, authz.user.id, body.stripeId, body.nativeId, authz.allowedSubsidiaryIds);
    } else {
      await linkStripeSubscription(authz.user.orgId, authz.user.id, body.stripeId, body.nativeId, authz.allowedSubsidiaryIds);
    }
    return Response.json({ ok: true });
  },
});
