import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { NextResponse } from "next/server";
import { isUuid } from "@/lib/list-params";
import { loadActivity } from "@/lib/crm";
import { notFound } from "@/lib/api/responses";
import {
  deleteCrmActivity,
  requestBodySchema,
  updateCrmActivity,
} from "@/lib/crm/activity-actions";

export const runtime = "nodejs";

export const GET = defineRoute({
  permission: "crm.activities.read",
  feature: "crm",
  params: z.object({ id: z.string() }),
  handler: async ({ authz, params }) => {
    const activity = isUuid(params.id)
      ? await loadActivity(params.id, authz.user.orgId, authz.allowedSubsidiaryIds)
      : null;
    return activity ? NextResponse.json(activity) : notFound("record");
  },
});

export const PATCH = defineRoute({
  permission: "crm.activities.manage",
  feature: "crm",
  params: z.object({ id: z.string() }),
  body: requestBodySchema,
  invalidBodyStatus: 422,
  handler: async ({ authz, params, body }) => updateCrmActivity(authz, params, body),
});

export const DELETE = defineRoute({
  permission: "crm.activities.manage",
  feature: "crm",
  params: z.object({ id: z.string() }),
  handler: async ({ authz, params }) => deleteCrmActivity(authz, params),
});
