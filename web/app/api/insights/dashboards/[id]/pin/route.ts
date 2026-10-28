import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { isUuid } from "../../../../../../lib/list-params";
import { notFound } from "@/lib/api/responses";
import { setInsightDashboardPin } from "../../../../../../lib/insight-dashboard-pin";
const postBodySchema0 = z.strictObject({ pin: z.boolean() });

export const runtime = "nodejs";

/**
 * Toggle a personal pin for the current user. Pinned dashboards are what the
 * home surface offers a user via <DashboardEmbed/>. `{ pin: false }` unpins.
 */
export const POST = defineRoute({
  permission: "insights.read",
  feature: {
    none: "This insights surface is governed by its permission and has no separate organization feature switch.",
  },
  params: z.object({ id: z.string() }),
  body: postBodySchema0,
  handler: async ({ request: _req, authz: gate, params, body: routeBody }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");

    const { pin } = routeBody;
    const pinned = await setInsightDashboardPin(gate, id, pin);
    if (pinned === null) return notFound("record");
    return NextResponse.json({ pinned });
  },
});
