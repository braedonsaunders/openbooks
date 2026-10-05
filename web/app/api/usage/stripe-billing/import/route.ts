import { importStripeBilling } from "@openbooks/engine/sync";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";

const Body = z.object({
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();

export const POST = defineRoute({
  permission: "usage.manage",
  feature: "usageBilling",
  body: Body,
  handler: async ({ authz, body }) => Response.json(await importStripeBilling(
    authz.user.orgId,
    authz.user.id,
    { since: body.since, until: body.until },
  )),
});
