import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { getChannelMarginSummary } from "@openbooks/engine/commerce";
import { guardUnrestrictedScope } from "@/lib/authz";

export const runtime = "nodejs";

/**
 * Trailing order margin per channel and currency for the channels cockpit:
 * order counts, revenue and CM2 from current facts, the orders still
 * carrying estimated fees, and the imported ad spend beside them.
 */
export const GET = defineRoute({
  permission: "channels.read",
  feature: "salesChannels",
  handler: async ({ request, authz: gate }) => {
    // Spans every channel of the organization, including ones assigned to
    // subsidiaries outside a restricted caller's scope.
    const scopeDenied = guardUnrestrictedScope(gate);
    if (scopeDenied) return scopeDenied;
    const url = new URL(request.url);
    const days = Number(url.searchParams.get("days") ?? "30");
    const summary = await getChannelMarginSummary(gate.user.orgId, days);
    return NextResponse.json({
      channels: summary.map((row) => ({
        channelId: row.channelId,
        channelName: row.channelName,
        currency: row.currency,
        orders: row.orders,
        revenueMinor: row.revenueMinor.toString(),
        cm2Minor: row.cm2Minor.toString(),
        estimatedOrders: row.estimatedOrders,
        adSpendMinor: row.adSpendMinor.toString(),
      })),
    });
  },
});
