import { updateUsageMeter } from "@openbooks/engine/src/billing/usage/records.ts";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";

const Params = z.object({ id: z.string().uuid() }).strict();
const Body = z.object({
  key: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).optional(),
  unit: z.string().trim().min(1).optional(),
  aggregation: z.enum(["sum", "count", "max", "last", "unique_count"]).optional(),
  itemId: z.string().uuid().nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0 && Object.values(value).some((field) => field !== undefined),
  "Supply at least one meter field to update.");

export const PATCH = defineRoute({
  permission: "usage.manage",
  feature: "usageBilling",
  scope: "unrestricted",
  params: Params,
  body: Body,
  handler: async ({ authz, params, body }) => Response.json(await updateUsageMeter(authz.user.orgId, authz.user.id, params.id, body)),
});
