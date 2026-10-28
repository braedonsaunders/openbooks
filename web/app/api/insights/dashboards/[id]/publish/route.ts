import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { setInsightPublication } from "@/lib/insight-mutations";
import { isUuid } from "../../../../../../lib/list-params";
import { notFound } from "@/lib/api/responses";
const postBodySchema0 = z.strictObject({
  publish: z.boolean().optional(),
  expectedUpdatedAt: z
    .string()
    .regex(
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
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");
    return setInsightPublication(
      gate,
      "dashboard",
      id,
      routeBody.publish !== false,
      routeBody.expectedUpdatedAt,
    );
  },
});
