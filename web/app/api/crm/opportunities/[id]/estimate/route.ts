import { NextResponse } from "next/server";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { guardPermission } from "@/lib/authz";
import { isFeatureEnabled } from "@/lib/features";
import { notFound } from "@/lib/api/responses";
import { createCrmOpportunityEstimate } from "@/lib/crm/opportunity-estimate";

export const runtime = "nodejs";

async function authorizeEstimate() {
  const gate = await guardPermission("crm.opportunities.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "crm"))) return notFound("route");
  const receivables = await guardPermission("ar.create");
  return receivables instanceof NextResponse ? receivables : gate;
}

export const POST = defineRoute({
  authorize: authorizeEstimate,
  feature: "crm",
  params: z.object({ id: z.string() }),
  handler: async ({ request, authz, params }) => {
    const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() ?? "";
    return createCrmOpportunityEstimate(authz, params.id, idempotencyKey);
  },
});
