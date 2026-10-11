import { listNormalizationMonthStates } from "@openbooks/engine/billing/metrics/metrics-normalization-service";
import { defineRoute } from "@/lib/api/route";

export const GET = defineRoute({
  permission: "usage.read",
  feature: "saasMetrics",
  scope: "unrestricted",
  handler: async ({ authz }) => Response.json(await listNormalizationMonthStates(authz.user.orgId)),
});
