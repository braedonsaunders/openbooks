import { NextResponse } from "next/server";
import { listStakeholders } from "@openbooks/engine/equity";
import { defineRoute } from "@/lib/api/route";
import { entityQuery, parseQuery } from "../_schema";

export const runtime = "nodejs";

/** Holders on the legal entity's cap table with their directory details. */
export const GET = defineRoute({
  permission: "equity.read",
  feature: "equity",
  handler: async ({ authz, request }) => {
    const query = parseQuery(request, entityQuery);
    if (!query.ok) return query.response;
    return NextResponse.json(
      await listStakeholders({ orgId: authz.user.orgId, actorId: authz.user.id, ...query.data }),
    );
  },
});
