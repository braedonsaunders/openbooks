import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { createCrmOpportunityDraft } from "@/lib/crm/actions";

const requestBodySchema = z.strictObject({
  partyId: uuidString().nullable().optional(),
});

export const runtime = "nodejs";

export const POST = defineRoute({
  permission: "crm.opportunities.manage",
  feature: "crm",
  body: requestBodySchema,
  handler: async ({ authz, body }) => {
    const result = await createCrmOpportunityDraft(authz, body.partyId ?? null);
    if ("response" in result) return result.response;
    return NextResponse.json(result.body, { status: result.status });
  },
});
