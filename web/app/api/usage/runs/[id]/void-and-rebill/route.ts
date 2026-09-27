import { voidAndRebillRateRun } from "@openbooks/engine/src/billing/usage/rate-run.ts";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";

const Params = z.object({ id: z.string().uuid() }).strict();
const Body = z.object({ reason: z.string().trim().min(1).max(1000).optional() }).strict();

export const POST = defineRoute({
  permission: "usage.bill",
  feature: "usageBilling",
  params: Params,
  body: Body,
  handler: async ({ authz, params, body }) => Response.json(await voidAndRebillRateRun(
    authz.user.orgId,
    authz.user.id,
    params.id,
    body.reason,
    authz.allowedSubsidiaryIds,
  )),
});
