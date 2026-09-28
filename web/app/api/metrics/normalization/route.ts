import { listNormalizationMonthStates } from "@openbooks/engine/src/billing/metrics/metrics-normalization-service.ts";
import { defineRoute } from "@/lib/api/route";

export const GET = defineRoute({
  permission: "usage.read",
  feature: "saasMetrics",
  scope: "unrestricted",
  handler: async ({ authz }) => Response.json(await listNormalizationMonthStates(authz.user.orgId)),
});
