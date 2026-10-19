import { listSaasMetricsMonths } from "@openbooks/engine/billing/metrics/metrics-ledger";
import { defineRoute } from "@/lib/api/route";

export const GET = defineRoute({
  permission: "usage.read",
  feature: "saasMetrics",
  scope: "unrestricted",
  handler: async ({ authz }) => Response.json(await listSaasMetricsMonths(authz.user.orgId)),
});
