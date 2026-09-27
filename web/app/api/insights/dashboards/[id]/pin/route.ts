import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { insightDashboardPins } from "@openbooks/schema/src/insights.ts";
import { isUuid } from "../../../../../../lib/list-params";
import { loadDashboard } from "../../../_lib";
import { notFound } from "@/lib/api/responses";
const postBodySchema0 = z.strictObject({ pin: z.boolean() });

export { runtime } from "@/lib/api/route";

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
    const user = gate.user;
    const { id } = await params;
    if (!isUuid(id))
      return notFound("record");

    const dashboard = await loadDashboard(id, user.orgId);
    if (!dashboard)
      return notFound("record");

    const { pin } = routeBody;

    if (!pin) {
      await db.execute(sql`
      delete from insight_dashboard_pins
       where org_id = ${user.orgId} and user_id = ${user.id} and dashboard_id = ${id}
    `);
      return NextResponse.json({ pinned: false });
    }

    const next = await db.execute<{ n: number }>(sql`
    select coalesce(max(sort_order), -1) + 1 as n
      from insight_dashboard_pins
     where org_id = ${user.orgId} and user_id = ${user.id}
  `);

    await db
      .insert(insightDashboardPins)
      .values({
        orgId: user.orgId,
        userId: user.id,
        dashboardId: id,
        sortOrder: Number(next.rows[0]?.n ?? 0),
      })
      .onConflictDoNothing();

    return NextResponse.json({ pinned: true });
  },
});
