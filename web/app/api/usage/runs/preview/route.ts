import { previewRateRun } from "@openbooks/engine/src/billing/usage/rate-run.ts";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";

const Body = z.object({
  linkId: z.string().uuid(),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();

export const POST = defineRoute({
  permission: "usage.read",
  feature: "usageBilling",
  body: Body,
  handler: async ({ authz, body }) => Response.json(await previewRateRun(
    authz.user.orgId,
    body.linkId,
    body.periodStart,
    body.periodEnd,
    authz.allowedSubsidiaryIds,
  )),
});
