import { recomputeSaasMetrics } from "@openbooks/engine/src/billing/metrics/metrics-ledger.ts";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";

const Body = z.object({ month: z.string().regex(/^\d{4}-\d{2}-01$/) }).strict();

export const POST = defineRoute({
  permission: "usage.manage",
  feature: "saasMetrics",
  scope: "unrestricted",
  body: Body,
  handler: async ({ authz, body }) => Response.json(await recomputeSaasMetrics(authz.user.orgId, body.month)),
});
