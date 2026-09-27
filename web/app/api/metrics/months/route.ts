import { listSaasMetricsMonths } from "@openbooks/engine/src/billing/metrics/metrics-ledger.ts";
import { defineRoute } from "@/lib/api/route";

export const GET = defineRoute({
  permission: "usage.read",
  feature: "saasMetrics",
  handler: async ({ authz }) => Response.json(await listSaasMetricsMonths(authz.user.orgId)),
});
