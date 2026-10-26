import { previewRateRun } from "@openbooks/engine/billing/usage/rate-run";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";

const Body = z
  .object({
    linkId: uuidString(),
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

export const POST = defineRoute({
  permission: "usage.read",
  feature: "usageBilling",
  body: Body,
  handler: async ({ authz, body }) =>
    Response.json(
      await previewRateRun(
        authz.user.orgId,
        body.linkId,
        body.periodStart,
        body.periodEnd,
        authz.allowedSubsidiaryIds,
      ),
    ),
});
