import { saveStripeBillingSchedule } from "@openbooks/engine/sync";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";

const Body = z.object({
  cadence: z.enum(["off", "hourly", "daily"]),
}).strict();

export const PUT = defineRoute({
  permission: "usage.manage",
  feature: "usageBilling",
  body: Body,
  handler: async ({ authz, body }) => Response.json({
    cadence: await saveStripeBillingSchedule(authz.user.orgId, authz.user.id, body.cadence),
  }),
});
