import { readRetentionStrip } from "@openbooks/engine/src/billing/metrics/metrics-ledger.ts";
import { defineRoute } from "@/lib/api/route";

/**
 * Latest computed month's recurring-revenue ratios (ARR, NRR/GRR, churn,
 * ARPA, quick ratio), one row per reporting currency. Values come from the
 * stored additive facts through the Reports hub's own formula trees — the
 * dashboard can never disagree with the hub, and ratios are never stored.
 */
export const GET = defineRoute({
  permission: "usage.read",
  feature: "saasMetrics",
  handler: async ({ authz }) => Response.json(await readRetentionStrip(authz.user.orgId)),
});
