import { reverseUsageRecord } from "@openbooks/engine/src/billing/usage/records.ts";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";

const Params = z.object({ id: z.string().uuid() }).strict();
const Body = z.object({
  reason: z.string().trim().min(1),
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict();

export const POST = defineRoute({
  permission: "usage.manage",
  feature: "usageBilling",
  params: Params,
  body: Body,
  handler: async ({ authz, params, body }) => Response.json(await reverseUsageRecord(
    authz.user.orgId,
    authz.user.id,
    params.id,
    body.reason,
    body.occurredOn,
    authz.allowedSubsidiaryIds,
  )),
});
