import { createUsageRatingPlanVersion } from "@openbooks/engine/billing/usage/rating-plans";
import { defineRoute } from "@/lib/api/route";
import { idempotentUsageCreate } from "../../../_idempotent";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";

const Params = z.object({ id: uuidString() }).strict();
const Body = z.object({ effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict();

export const POST = defineRoute({
  permission: "usage.manage",
  feature: "usageBilling",
  scope: "unrestricted",
  params: Params,
  body: Body,
  handler: async ({ request, authz, params, body }) =>
    idempotentUsageCreate({
      request,
      authz,
      operation: "usage.plan_version.create",
      requestBody: { planId: params.id, ...body },
      execute: () =>
        createUsageRatingPlanVersion(authz.user.orgId, authz.user.id, {
          planId: params.id,
          ...body,
        }),
    }),
});
