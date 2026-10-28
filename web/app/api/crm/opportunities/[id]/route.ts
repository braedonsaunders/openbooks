import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { NextResponse } from "next/server";
import { jsonObject } from "@/lib/api/json";
import { isUuid } from "@/lib/list-params";
import { loadOpportunity } from "@/lib/crm";
import { notFound } from "@/lib/api/responses";
import { patchCrmOpportunity, deleteCrmOpportunity } from "@/lib/crm/opportunity-actions";

export const runtime = "nodejs";

export const GET = defineRoute({
  permission: "crm.opportunities.read",
  feature: "crm",
  params: z.object({ id: z.string() }),
  handler: async ({ authz: gate, params }) => {
    const opportunity = isUuid(params.id)
      ? await loadOpportunity(params.id, gate.user.orgId, gate.allowedSubsidiaryIds)
      : null;
    return opportunity ? NextResponse.json(opportunity) : notFound("record");
  },
});

export const PATCH = defineRoute({
  permission: "crm.opportunities.manage",
  feature: "crm",
  params: z.object({ id: z.string() }),
  body: jsonObject,
  handler: async ({ authz: gate, params, body }) =>
    patchCrmOpportunity(gate, params.id, body as Record<string, unknown>),
});

export const DELETE = defineRoute({
  permission: "crm.opportunities.manage",
  feature: "crm",
  params: z.object({ id: z.string() }),
  handler: async ({ authz: gate, params }) => deleteCrmOpportunity(gate, params.id),
});
