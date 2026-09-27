import { createUsageMeter, listUsageMeters } from "@openbooks/engine/src/billing/usage/records.ts";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { idempotentUsageCreate } from "../_idempotent";

const Body = z.object({
  key: z.string().trim().min(1),
  name: z.string().trim().min(1),
  unit: z.string().trim().min(1),
  aggregation: z.enum(["sum", "count", "max", "last", "unique_count"]),
  itemId: z.string().uuid().nullable().optional(),
}).strict();

export const GET = defineRoute({
  permission: "usage.read",
  feature: "usageBilling",
  handler: async ({ authz }) => Response.json(await listUsageMeters(authz.user.orgId)),
});

export const POST = defineRoute({
  permission: "usage.manage",
  feature: "usageBilling",
  scope: "unrestricted",
  body: Body,
  handler: async ({ request, authz, body }) => idempotentUsageCreate({
    request,
    authz,
    operation: "usage.meter.create",
    requestBody: body,
    execute: () => createUsageMeter(authz.user.orgId, authz.user.id, body),
  }),
});
