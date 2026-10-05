import { listUsageRatingSettings, saveUsageRatingSchedule } from "@openbooks/engine/billing";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";

const Body = z.object({
  linkId: z.string().uuid().nullish(),
  cadence: z.enum(["billing_period", "monthly", "paused"]).optional(),
  graceDays: z.number().int().min(0).max(30).optional(),
  mode: z.enum(["draft", "auto_commit"]).optional(),
}).strict();

export const GET = defineRoute({
  permission: "usage.read",
  feature: "usageBilling",
  handler: async ({ authz }) => Response.json(await listUsageRatingSettings(authz.user.orgId)),
});

export const PUT = defineRoute({
  permission: "usage.manage",
  feature: "usageBilling",
  body: Body,
  handler: async ({ authz, body }) => Response.json(await saveUsageRatingSchedule(
    authz.user.orgId,
    authz.user.id,
    { linkId: body.linkId ?? null, cadence: body.cadence, graceDays: body.graceDays, mode: body.mode },
  )),
});
