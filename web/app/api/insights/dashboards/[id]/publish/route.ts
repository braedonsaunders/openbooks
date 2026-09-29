import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { mutateInsight } from "@/lib/insight-mutations";
import { UNTITLED_DASHBOARD_NAME } from "@/lib/insight-untitled";
import { isUuid } from "../../../../../../lib/list-params";
import { loadDashboard } from "../../../_lib";
import { notFound } from "@/lib/api/responses";
const postBodySchema0 = z.strictObject({
  publish: z.boolean().optional(),
  expectedUpdatedAt: z.string().regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
    "expectedUpdatedAt must be the exact dashboard revision",
  ),
});

export const runtime = "nodejs";

/** Publish / unpublish a dashboard. Publishing requires a real name. */
export const POST = defineRoute({
  permission: "insights.publish",
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

    const body = routeBody;
    const publish = body.publish !== false;

    return mutateInsight(
      gate,
      "insight_dashboards",
      id,
      "update",
      async (tx, before, revision) => {
        if (
          typeof body.expectedUpdatedAt !== "string" ||
          body.expectedUpdatedAt !== revision
        ) {
          return NextResponse.json(
            {
              error:
                "The record changed; reload and review the latest revision before publishing.",
            },
            { status: 409 },
          );
        }
        const dashboard = before!;
        if (
          publish &&
          (typeof dashboard.name !== "string" ||
            dashboard.name.trim() === "" ||
            dashboard.name === UNTITLED_DASHBOARD_NAME)
        ) {
          return NextResponse.json(
            { error: "Give the dashboard a real name before publishing." },
            { status: 422 },
          );
        }

        await tx.execute(sql`
    update insight_dashboards
       set status = ${publish ? "published" : "draft"}, updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'), updated_by = ${user.id}
     where id = ${id} and org_id = ${user.orgId}
  `);

        const updated = await tx.execute(
          sql`select *, to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at from insight_dashboards where id = ${id} and org_id = ${user.orgId}`,
        );
        return NextResponse.json(updated.rows[0]);
      },
    );
  },
});
