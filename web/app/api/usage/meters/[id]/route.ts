import { updateUsageMeter } from "@openbooks/engine/billing/usage/records";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";

const Params = z.object({ id: uuidString() }).strict();
const Body = z
  .object({
    key: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    unit: z.string().trim().min(1).optional(),
    aggregation: z.enum(["sum", "count", "max", "last", "unique_count"]).optional(),
    itemId: uuidString().nullable().optional(),
  })
  .strict()
  .refine(
    (value) =>
      Object.keys(value).length > 0 && Object.values(value).some((field) => field !== undefined),
    "Supply at least one meter field to update.",
  );

export const PATCH = defineRoute({
  permission: "usage.manage",
  feature: "usageBilling",
  invalidBodyStatus: 422,
  scope: "unrestricted",
  params: Params,
  body: Body,
  handler: async ({ authz, params, body }) =>
    Response.json(await updateUsageMeter(authz.user.orgId, authz.user.id, params.id, body)),
});
